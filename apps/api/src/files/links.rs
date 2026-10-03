//! Public links: a file handed to someone outside the space.
//!
//! Managing a file's links (create, list, revoke) takes the right to manage the file (its owner, or
//! an owner or administrator of the space), and never a guest. The public side needs no session: the
//! link's token is the capability. A link answers only while it is live: not revoked, not expired,
//! its file a file still in the space (not a folder, not in the trash, not erased), and public links
//! not turned off for the instance (`RUCHOIR_PUBLIC_LINKS`). Anything else is a `404`, the same for
//! every reason, so a token says nothing about a file it no longer opens.
//!
//! A password-protected link shows nothing before its password. The right password earns a grant,
//! a random key kept an hour in Valkey, which the download then carries: the password is sent once,
//! in a request body, never in an address.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use fred::prelude::{Expiration, KeysInterface};
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{file_links, file_versions, files};
use crate::state::AppState;

use super::authz;
use super::dto::rfc3339;
use super::error::FileError;
use super::thumbnail::THUMBNAIL_MIME;

/// How long a grant earned by the right password lasts.
const GRANT_TTL_SECS: i64 = 3600;
const GRANT_PREFIX: &str = "link:grant:";
/// The longest password a link takes (argon2 has no use for more, and a body has a size).
const MAX_PASSWORD: usize = 256;

/// One of a file's public links, for those who manage the file.
#[derive(Debug, Serialize, ToSchema)]
pub struct LinkDto {
    pub id: Uuid,
    /// The key the public address carries: `/s/?t=<token>`.
    pub token: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Whether it has passed its expiry (it is then dead, and kept only to say so).
    pub expired: bool,
    pub has_password: bool,
    pub download_count: i32,
}

/// What a new link should be.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateLinkRequest {
    /// When it stops working, RFC 3339 (absent: never). Must be in the future.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// The password it asks for (absent or blank: none).
    #[serde(default)]
    pub password: Option<String>,
}

/// What a public link shows. Only `needs_password` until the password has been given.
#[derive(Debug, Serialize, ToSchema)]
pub struct PublicLinkDto {
    pub needs_password: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub has_thumbnail: bool,
    /// How the page can show it: `image`, `pdf`, `document` (an office file, shown as a PDF and as
    /// its first page), `video`, `audio` or `text`. Absent: nothing to show but its name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// The password, to unlock a protected link.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UnlockRequest {
    pub password: String,
}

/// What the right password earns.
#[derive(Debug, Serialize, ToSchema)]
pub struct UnlockedDto {
    /// The key the download and the thumbnail carry, for an hour.
    pub grant: String,
    pub link: PublicLinkDto,
}

/// A grant, as a public request carries it.
#[derive(Debug, Deserialize, IntoParams)]
pub struct GrantQuery {
    /// The key a protected link's password earned.
    #[serde(default)]
    pub grant: Option<String>,
}

/// The public routes: no session, rate-limited where they are mounted (`http.rs`).
pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/public/links/{token}", get(public_link))
        .route("/api/v1/public/links/{token}/unlock", post(unlock))
        .route(
            "/api/v1/public/links/{token}/download",
            get(public_download),
        )
        .route(
            "/api/v1/public/links/{token}/thumbnail",
            get(public_thumbnail),
        )
        .route("/api/v1/public/links/{token}/preview", get(public_preview))
        .route(
            "/api/v1/public/links/{token}/document",
            get(public_document),
        )
        .route("/api/v1/public/links/{token}/page", get(public_page))
}

/// `GET /api/v1/files/{file_id}/links`: the file's live public links, newest first.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/links",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The links", body = [LinkDto]),
        (status = 403, description = "Not allowed to manage this file's links")
    )
)]
pub async fn list_links(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Json<Vec<LinkDto>>, FileError> {
    ensure_link_manager(&state.db, file_id, session.user_id).await?;
    let links = file_links::Entity::find()
        .filter(file_links::Column::FileId.eq(file_id))
        .filter(file_links::Column::RevokedAt.is_null())
        .order_by_desc(file_links::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let names = super::load_names(
        &state.db,
        links.iter().filter_map(|l| l.created_by).collect(),
    )
    .await?;
    let now = OffsetDateTime::now_utc();
    Ok(Json(
        links
            .into_iter()
            .map(|l| LinkDto {
                id: l.id,
                created_by_name: l.created_by.and_then(|id| names.get(&id).cloned()),
                created_at: rfc3339(l.created_at),
                expires_at: l.expires_at.map(rfc3339),
                expired: l.expires_at.is_some_and(|at| at <= now),
                has_password: l.password_hash.is_some(),
                download_count: l.download_count,
                token: l.token,
            })
            .collect(),
    ))
}

/// `POST /api/v1/files/{file_id}/links`: hand the file out by a new public link.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/links",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    request_body = CreateLinkRequest,
    responses(
        (status = 201, description = "The new link", body = LinkDto),
        (status = 400, description = "A folder, an expiry in the past, or a password too long"),
        (status = 403, description = "Not allowed, or public links are off for this instance")
    )
)]
pub async fn create_link(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Json(body): Json<CreateLinkRequest>,
) -> Result<(StatusCode, Json<LinkDto>), FileError> {
    if !state.config.public_links {
        return Err(FileError::Forbidden);
    }
    let file = ensure_link_manager(&state.db, file_id, session.user_id).await?;
    let now = OffsetDateTime::now_utc();
    let expires_at = match body
        .expires_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(raw) => {
            let at = OffsetDateTime::parse(raw, &Rfc3339)
                .map_err(|_| FileError::BadRequest("invalid expiry"))?;
            if at <= now {
                return Err(FileError::BadRequest("expiry in the past"));
            }
            Some(at)
        }
    };
    let password = body.password.as_deref().filter(|p| !p.trim().is_empty());
    if password.is_some_and(|p| p.len() > MAX_PASSWORD) {
        return Err(FileError::BadRequest("password too long"));
    }
    let password_hash = match password {
        None => None,
        Some(p) => {
            Some(crate::auth::hash_password(&state.config, p).map_err(|_| FileError::Internal)?)
        }
    };

    let link = file_links::ActiveModel {
        id: Set(Uuid::new_v4()),
        file_id: Set(file.id),
        space_id: Set(file.space_id),
        token: Set(random_hex(24)?),
        created_by: Set(Some(session.user_id)),
        created_at: Set(now),
        expires_at: Set(expires_at),
        password_hash: Set(password_hash),
        download_count: Set(0),
        revoked_at: Set(None),
    }
    .insert(&state.db)
    .await?;
    let names = super::load_names(&state.db, vec![session.user_id]).await?;
    Ok((
        StatusCode::CREATED,
        Json(LinkDto {
            id: link.id,
            created_at: rfc3339(link.created_at),
            created_by_name: names.get(&session.user_id).cloned(),
            expires_at: link.expires_at.map(rfc3339),
            expired: false,
            has_password: link.password_hash.is_some(),
            download_count: 0,
            token: link.token,
        }),
    ))
}

/// `DELETE /api/v1/files/{file_id}/links/{link_id}`: revoke a public link.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}/links/{link_id}",
    tag = "files",
    params(
        ("file_id" = Uuid, Path, description = "File id"),
        ("link_id" = Uuid, Path, description = "Link id")
    ),
    responses(
        (status = 204, description = "Revoked"),
        (status = 403, description = "Not allowed to manage this file's links"),
        (status = 404, description = "No such link on this file")
    )
)]
pub async fn revoke_link(
    State(state): State<AppState>,
    session: AuthSession,
    Path((file_id, link_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, FileError> {
    ensure_link_manager(&state.db, file_id, session.user_id).await?;
    let link = file_links::Entity::find_by_id(link_id)
        .one(&state.db)
        .await?
        .filter(|l| l.file_id == file_id)
        .ok_or(FileError::NotFound)?;
    if link.revoked_at.is_none() {
        file_links::ActiveModel {
            id: Set(link.id),
            revoked_at: Set(Some(OffsetDateTime::now_utc())),
            ..Default::default()
        }
        .update(&state.db)
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/public/links/{token}`: what a public link shows (only whether it asks for a
/// password, until it has been given).
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The shared file, or that it asks for a password", body = PublicLinkDto),
        (status = 404, description = "No live link under this key")
    )
)]
pub async fn public_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
) -> Result<Json<PublicLinkDto>, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Ok(Json(PublicLinkDto {
            needs_password: true,
            name: None,
            size_bytes: None,
            mime_type: None,
            shared_by: None,
            expires_at: None,
            has_thumbnail: false,
            preview: None,
        }));
    }
    Ok(Json(describe(&state, &link, &file).await?))
}

/// `POST /api/v1/public/links/{token}/unlock`: give a protected link its password.
#[utoipa::path(
    post,
    path = "/api/v1/public/links/{token}/unlock",
    tag = "files",
    params(("token" = String, Path, description = "The link's key")),
    request_body = UnlockRequest,
    responses(
        (status = 200, description = "The right password: the file, and a grant for an hour", body = UnlockedDto),
        (status = 403, description = "The wrong password"),
        (status = 404, description = "No live link under this key")
    )
)]
pub async fn unlock(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<UnlockRequest>,
) -> Result<Json<UnlockedDto>, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    let right = match link.password_hash.as_deref() {
        // A link without a password needs no unlocking; a grant does no harm.
        None => true,
        Some(phc) => {
            body.password.len() <= MAX_PASSWORD
                && crate::auth::verify_password(&state.config, &body.password, phc)
        }
    };
    if !right {
        return Err(FileError::Forbidden);
    }
    let grant = random_hex(32)?;
    let _: () = state
        .valkey
        .set(
            format!("{GRANT_PREFIX}{grant}").as_str(),
            link.id.to_string(),
            Some(Expiration::EX(GRANT_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| FileError::Internal)?;
    Ok(Json(UnlockedDto {
        grant,
        link: describe(&state, &link, &file).await?,
    }))
}

/// `GET /api/v1/public/links/{token}/download`: the shared file's bytes.
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}/download",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The file's bytes"),
        (status = 403, description = "A protected link without its grant"),
        (status = 404, description = "No live link under this key")
    )
)]
pub async fn public_download(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
) -> Result<Response, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Err(FileError::Forbidden);
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let version = current_version(&state.db, &file).await?;
    let key = version.storage_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;
    file_links::Entity::update_many()
        .col_expr(
            file_links::Column::DownloadCount,
            Expr::col(file_links::Column::DownloadCount).add(Expr::val(1)),
        )
        .filter(file_links::Column::Id.eq(link.id))
        .exec(&state.db)
        .await?;
    super::download::build_response(bytes, &version.mime_type, "attachment", &file.name, false)
}

/// `GET /api/v1/public/links/{token}/thumbnail`: the shared image's thumbnail.
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}/thumbnail",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The thumbnail"),
        (status = 403, description = "A protected link without its grant"),
        (status = 404, description = "No live link, or no thumbnail")
    )
)]
pub async fn public_thumbnail(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
) -> Result<Response, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Err(FileError::Forbidden);
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let version = current_version(&state.db, &file).await?;
    let key = version.thumbnail_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;
    super::download::build_response(bytes, THUMBNAIL_MIME, "inline", "thumbnail.jpg", true)
}

/// How a shared file can be shown in its page, from what it is.
fn preview_kind(mime: &str, name: &str) -> Option<&'static str> {
    if mime.starts_with("image/") {
        Some("image")
    } else if mime == "application/pdf" {
        Some("pdf")
    } else if super::convert::office_extension(mime, name).is_some() {
        Some("document")
    } else if mime.starts_with("video/") {
        Some("video")
    } else if mime.starts_with("audio/") {
        Some("audio")
    } else if mime.starts_with("text/")
        || (mime == "application/octet-stream" && is_text_name(name))
    {
        // An HTML file too: it is served as plain text (see `public_preview`), its source shown.
        Some("text")
    } else {
        None
    }
}

/// The extensions of plain text. A text has no signature, so the sniffed type of an upload is
/// `application/octet-stream` (`mime.rs`) and its name is all there is to go on; it is only ever
/// served as `text/plain`, so a wrong name shows garbled text at worst.
const TEXT_EXTENSIONS: [&str; 12] = [
    "txt", "md", "markdown", "log", "json", "xml", "yaml", "yml", "ini", "toml", "tsv", "conf",
];

fn is_text_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        TEXT_EXTENSIONS
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// `GET /api/v1/public/links/{token}/preview`: the shared file's bytes, inline when its page can show
/// them (an image, a PDF, a video, a sound, a text). Answers a byte range, which a phone's player
/// asks for before it plays a video at all.
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}/preview",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The bytes, inline"),
        (status = 206, description = "The range asked for"),
        (status = 400, description = "Nothing the page can show inline"),
        (status = 403, description = "A protected link without its grant"),
        (status = 404, description = "No live link under this key")
    )
)]
pub async fn public_preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Response, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Err(FileError::Forbidden);
    }
    let version = current_version(&state.db, &file).await?;
    let kind = preview_kind(&version.mime_type, &file.name);
    if !matches!(kind, Some("image" | "pdf" | "video" | "audio" | "text")) {
        return Err(FileError::BadRequest("nothing to show inline"));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let key = version.storage_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;
    // A text is shown as text, whatever it says it is: never run as a page.
    let mime = if kind == Some("text") {
        "text/plain; charset=utf-8"
    } else {
        version.mime_type.as_str()
    };
    ranged(bytes, mime, &file.name, &headers)
}

/// `GET /api/v1/public/links/{token}/document`: a shared office document, as a PDF.
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}/document",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The document as a PDF, inline"),
        (status = 400, description = "Not an office document"),
        (status = 403, description = "A protected link without its grant"),
        (status = 404, description = "No live link under this key"),
        (status = 502, description = "The conversion failed")
    )
)]
pub async fn public_document(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
) -> Result<Response, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Err(FileError::Forbidden);
    }
    let version = current_version(&state.db, &file).await?;
    let extension = super::convert::office_extension(&version.mime_type, &file.name)
        .ok_or(FileError::BadRequest("not an office document"))?;
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let pdf = super::convert::document_pdf(storage, &version, extension).await?;
    let stem = file
        .name
        .rsplit_once('.')
        .map_or(file.name.as_str(), |(s, _)| s);
    let mut response = super::download::build_response(
        pdf,
        "application/pdf",
        "inline",
        &format!("{stem}.pdf"),
        false,
    )?;
    response.headers_mut().insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_static(super::download::PREVIEW_CSP),
    );
    Ok(response)
}

/// `GET /api/v1/public/links/{token}/page`: a shared office document's first page, as a picture.
#[utoipa::path(
    get,
    path = "/api/v1/public/links/{token}/page",
    tag = "files",
    params(("token" = String, Path, description = "The link's key"), GrantQuery),
    responses(
        (status = 200, description = "The first page"),
        (status = 400, description = "Not an office document"),
        (status = 403, description = "A protected link without its grant"),
        (status = 404, description = "No live link under this key"),
        (status = 502, description = "The conversion failed")
    )
)]
pub async fn public_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<GrantQuery>,
) -> Result<Response, FileError> {
    let (link, file) = live_link(&state, &token).await?;
    if link.password_hash.is_some() && !granted(&state, &link, query.grant.as_deref()).await? {
        return Err(FileError::Forbidden);
    }
    let version = current_version(&state.db, &file).await?;
    let extension = super::convert::office_extension(&version.mime_type, &file.name)
        .ok_or(FileError::BadRequest("not an office document"))?;
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let picture = super::convert::document_page(storage, &version, extension, PAGE_MAX_PX).await?;
    super::download::build_response(picture, THUMBNAIL_MIME, "inline", "page.jpg", true)
}

/// The widest a document's first page is drawn for its page (twice a phone's width, for its screen).
const PAGE_MAX_PX: u32 = 900;

/// The whole body, or the one range a `Range: bytes=a-b` header asks for.
fn ranged(
    bytes: Vec<u8>,
    mime: &str,
    name: &str,
    headers: &axum::http::HeaderMap,
) -> Result<Response, FileError> {
    use axum::http::{header, HeaderValue};
    let total = bytes.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(start, end)| {
            let start: usize = start.trim().parse().ok()?;
            let end: usize = if end.trim().is_empty() {
                total.checked_sub(1)?
            } else {
                end.trim().parse().ok()?
            };
            (start <= end && start < total).then_some((start, end.min(total - 1)))
        });
    let mut response = match range {
        Some((start, end)) => {
            let mut r = super::download::build_response(
                bytes[start..=end].to_vec(),
                mime,
                "inline",
                name,
                false,
            )?;
            *r.status_mut() = StatusCode::PARTIAL_CONTENT;
            r.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}"))
                    .map_err(|_| FileError::Internal)?,
            );
            r
        }
        None => super::download::build_response(bytes, mime, "inline", name, false)?,
    };
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(super::download::PREVIEW_CSP),
    );
    Ok(response)
}

/// The file, when the caller may manage its links: its owner or an owner or administrator of its
/// space, not a guest, and a file rather than a folder.
async fn ensure_link_manager(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<files::Model, FileError> {
    let access = authz::ensure_editable(db, file_id, user_id).await?;
    if access.file.conversation_id.is_none() {
        authz::ensure_space_files_member(db, access.file.space_id, user_id).await?;
    } else {
        // A private conversation's file belongs to its participants, not to whoever holds a link.
        return Err(FileError::Forbidden);
    }
    if access.file.kind == "folder" {
        return Err(FileError::BadRequest("a folder cannot be shared by link"));
    }
    Ok(access.file)
}

/// The live link under `token`, with its file, or `404` whatever the reason.
async fn live_link(
    state: &AppState,
    token: &str,
) -> Result<(file_links::Model, files::Model), FileError> {
    if !state.config.public_links
        || token.len() != 48
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(FileError::NotFound);
    }
    let link = file_links::Entity::find()
        .filter(file_links::Column::Token.eq(token))
        .one(&state.db)
        .await?
        .ok_or(FileError::NotFound)?;
    let now = OffsetDateTime::now_utc();
    if link.revoked_at.is_some() || link.expires_at.is_some_and(|at| at <= now) {
        return Err(FileError::NotFound);
    }
    let file = files::Entity::find_by_id(link.file_id)
        .one(&state.db)
        .await?
        .filter(|f| {
            f.deleted_at.is_none()
                && f.purged_at.is_none()
                && f.kind != "folder"
                && f.conversation_id.is_none()
        })
        .ok_or(FileError::NotFound)?;
    Ok((link, file))
}

/// Whether `grant` is one this link's password earned.
async fn granted(
    state: &AppState,
    link: &file_links::Model,
    grant: Option<&str>,
) -> Result<bool, FileError> {
    let Some(grant) = grant.filter(|g| g.len() == 64 && g.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return Ok(false);
    };
    let id: Option<String> = state
        .valkey
        .get(format!("{GRANT_PREFIX}{grant}").as_str())
        .await
        .map_err(|_| FileError::Internal)?;
    Ok(id.as_deref() == Some(link.id.to_string().as_str()))
}

/// What a live link shows of its file.
async fn describe(
    state: &AppState,
    link: &file_links::Model,
    file: &files::Model,
) -> Result<PublicLinkDto, FileError> {
    let version = current_version(&state.db, file).await.ok();
    let sharer = link.created_by.or(file.owner_id);
    let names = super::load_names(&state.db, sharer.into_iter().collect()).await?;
    Ok(PublicLinkDto {
        needs_password: false,
        name: Some(file.name.clone()),
        size_bytes: Some(
            version
                .as_ref()
                .map(|v| v.size_bytes)
                .unwrap_or(file.size_bytes),
        ),
        mime_type: version.as_ref().map(|v| v.mime_type.clone()),
        shared_by: sharer.and_then(|id| names.get(&id).cloned()),
        expires_at: link.expires_at.map(rfc3339),
        has_thumbnail: version.as_ref().is_some_and(|v| v.thumbnail_key.is_some()),
        preview: version
            .as_ref()
            .and_then(|v| preview_kind(&v.mime_type, &file.name))
            .map(str::to_owned),
    })
}

async fn current_version(
    db: &DatabaseConnection,
    file: &files::Model,
) -> Result<file_versions::Model, FileError> {
    let id = file.current_version_id.ok_or(FileError::NotFound)?;
    file_versions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or(FileError::NotFound)
}

/// `bytes` random bytes, as hex.
fn random_hex(bytes: usize) -> Result<String, FileError> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|_| FileError::Internal)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}
