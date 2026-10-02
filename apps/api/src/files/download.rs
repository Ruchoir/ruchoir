//! Byte endpoints: download, inline preview, and thumbnail.
//!
//! All bytes are proxied back through the API (the browser never contacts the object store), served
//! with the stored content type, `Content-Disposition` (attachment for download, inline only for
//! safe preview types), and the global `X-Content-Type-Options: nosniff`, so uploaded content is
//! never rendered or executed in an unexpected context.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use sea_orm::{DatabaseConnection, EntityTrait};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{file_versions, files};
use crate::state::AppState;

use super::authz;
use super::error::FileError;
use super::mime;
use super::thumbnail::THUMBNAIL_MIME;

/// `GET /api/v1/files/{file_id}/download`: stream the current version's bytes as an attachment.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/download",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The file bytes"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "File or its bytes not found"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn download_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Response, FileError> {
    serve_object(&state, session.user_id, file_id, false, &HeaderMap::new()).await
}

/// `GET /api/v1/files/{file_id}/preview`: serve the bytes inline for previewable types.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/preview",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The file bytes (inline when previewable)"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "File or its bytes not found"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn preview_file(
    State(state): State<AppState>,
    session: AuthSession,
    headers: HeaderMap,
    Path(file_id): Path<Uuid>,
) -> Result<Response, FileError> {
    serve_object(&state, session.user_id, file_id, true, &headers).await
}

/// `GET /api/v1/files/{file_id}/thumbnail`: the current version's thumbnail (images only).
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/thumbnail",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The thumbnail image"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "No thumbnail for this file"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn thumbnail_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Response, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let version = current_version(&state.db, &access.file).await?;
    let key = version.thumbnail_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;

    build_response(bytes, THUMBNAIL_MIME, "inline", "thumbnail.jpg", true)
}

/// Shared body of download/preview: authorize, load the current version, fetch and return the bytes.
async fn serve_object(
    state: &AppState,
    user_id: Uuid,
    file_id: Uuid,
    inline: bool,
    request_headers: &HeaderMap,
) -> Result<Response, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, user_id).await?;
    let file = access.file;
    if file.kind == "folder" {
        return Err(FileError::BadRequest("cannot download a folder"));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;

    let version = current_version(&state.db, &file).await?;
    // An inline preview is revalidated, not re-sent: the tag is the version, so the browser keeps
    // its copy until the file changes and asks the API (which still checks access) each time.
    let tag = version_etag(version.id);
    if inline && is_fresh(request_headers, &tag) {
        return not_modified(&tag);
    }
    let key = version.storage_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;

    // Preview serves safe types inline; everything else (and every download) is an attachment.
    let disposition = if inline && mime::is_inline_previewable(&version.mime_type) {
        "inline"
    } else {
        "attachment"
    };
    let mut response = build_response(bytes, &version.mime_type, disposition, &file.name, false)?;
    if disposition == "inline" {
        // The app shows a preview in a same-origin frame, which the global policy forbids
        // (`frame-ancestors 'none'`). This one allows our own page to frame it and nothing else:
        // no script, no remote request, so an SVG or a PDF cannot run code from the preview.
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(PREVIEW_CSP),
        );
        with_validator(&mut response, &tag);
    }
    Ok(response)
}

/// The entity tag of a version: versions never change, so the id says it all.
pub(super) fn version_etag(version_id: Uuid) -> String {
    format!("\"{version_id}\"")
}

/// Whether the browser already holds the version `tag` names.
pub(super) fn is_fresh(request_headers: &HeaderMap, tag: &str) -> bool {
    request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|candidate| candidate.trim() == tag))
}

/// `304 Not Modified`, carrying the tag and the same caching rule as the full response.
pub(super) fn not_modified(tag: &str) -> Result<Response, FileError> {
    let mut response = Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .body(Body::empty())
        .map_err(|_| FileError::Internal)?;
    // The browser applies a `304`'s headers to its stored copy: without this policy the global one
    // (`frame-ancestors 'none'`) would land on it and the frame would refuse to show the file.
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PREVIEW_CSP),
    );
    with_validator(&mut response, tag);
    Ok(response)
}

/// Let the browser keep the response and revalidate it with the tag before every reuse.
pub(super) fn with_validator(response: &mut Response, tag: &str) {
    if let Ok(value) = HeaderValue::from_str(tag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
}

/// Policy of an inline preview: framable by the app only, and inert.
pub(super) const PREVIEW_CSP: &str =
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

/// The current version of a file, or a `404` when it was never uploaded.
pub(crate) async fn current_version(
    db: &DatabaseConnection,
    file: &files::Model,
) -> Result<file_versions::Model, FileError> {
    let version_id = file.current_version_id.ok_or(FileError::NotFound)?;
    file_versions::Entity::find_by_id(version_id)
        .one(db)
        .await?
        .ok_or(FileError::NotFound)
}

/// Assemble a byte response with content type, disposition and an ASCII-safe filename.
pub(super) fn build_response(
    bytes: Vec<u8>,
    content_type: &str,
    disposition: &str,
    filename: &str,
    cacheable: bool,
) -> Result<Response, FileError> {
    let length = bytes.len();
    let disposition_value = format!("{disposition}; filename=\"{}\"", ascii_filename(filename));

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disposition_value)
        .header(header::CONTENT_LENGTH, length.to_string());
    if cacheable {
        // Thumbnails are immutable per version key; let the browser cache them privately.
        builder = builder.header(header::CACHE_CONTROL, "private, max-age=86400");
    }
    builder.body(Body::from(bytes)).map_err(|error| {
        tracing::error!(%error, "failed to build file response");
        FileError::Internal
    })
}

/// Reduce a filename to a header-safe ASCII form (quotes and backslashes dropped, non-ASCII replaced).
fn ascii_filename(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| {
            if c == '"' || c == '\\' || c.is_control() {
                '_'
            } else if c.is_ascii() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = mapped.trim();
    if trimmed.is_empty() {
        "download".to_owned()
    } else {
        trimmed.chars().take(255).collect()
    }
}
