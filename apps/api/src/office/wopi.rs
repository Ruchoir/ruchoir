//! The WOPI surface the engine calls: file info, bytes, saves and locks.
//!
//! Served on an internal listener only (`RUCHOIR_WOPI_LISTEN`), never published. Every call carries
//! an access token ([`super::tokens`]) naming one member and one file, and the member's rights are
//! checked again on each call: someone removed from a space mid-session can no longer save.
//! Status codes and headers follow the WOPI specification, which is what both Euro-Office and
//! Collabora Online expect.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::entities::users;
use crate::files::authz::{self, FileAccess};
use crate::files::error::FileError;
use crate::files::versions;
use crate::state::AppState;

use super::discovery::Mode;
use super::locks::{self, Outcome};
use super::tokens::{self, Grant};

const LOCK_HEADER: &str = "x-wopi-lock";
const ITEM_VERSION_HEADER: &str = "x-wopi-itemversion";

/// The internal WOPI router. Its body limit is the upload cap, so an oversized save is refused with
/// `413` before it is read.
pub fn wopi_router(state: AppState) -> Router {
    let limit = state.config.upload_max_bytes as usize;
    Router::new()
        .route(
            "/wopi/files/{file_id}",
            get(check_file_info).post(file_operation),
        )
        .route(
            "/wopi/files/{file_id}/contents",
            get(get_file).post(put_file),
        )
        .layer(DefaultBodyLimit::max(limit))
        .with_state(state)
}

#[derive(Deserialize)]
struct Access {
    access_token: String,
}

/// A WOPI refusal.
#[derive(Debug)]
enum WopiError {
    Unauthorized,
    NotFound,
    Conflict(String),
    TooLarge,
    NotImplemented,
    BadRequest,
    Internal,
}

impl IntoResponse for WopiError {
    fn into_response(self) -> Response {
        match self {
            WopiError::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
            WopiError::NotFound => StatusCode::NOT_FOUND.into_response(),
            WopiError::Conflict(lock) => {
                let mut response = StatusCode::CONFLICT.into_response();
                if let Ok(value) = HeaderValue::from_str(&lock) {
                    response
                        .headers_mut()
                        .insert(HeaderName::from_static(LOCK_HEADER), value);
                }
                response
            }
            WopiError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            WopiError::NotImplemented => StatusCode::NOT_IMPLEMENTED.into_response(),
            WopiError::BadRequest => StatusCode::BAD_REQUEST.into_response(),
            WopiError::Internal => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
}

impl From<super::error::OfficeError> for WopiError {
    fn from(_: super::error::OfficeError) -> Self {
        WopiError::Internal
    }
}

impl From<sea_orm::DbErr> for WopiError {
    fn from(error: sea_orm::DbErr) -> Self {
        tracing::error!(%error, "database error in WOPI handler");
        WopiError::Internal
    }
}

impl From<FileError> for WopiError {
    fn from(error: FileError) -> Self {
        match error {
            FileError::NotFound => WopiError::NotFound,
            FileError::Forbidden | FileError::BadRequest(_) => WopiError::Unauthorized,
            FileError::PayloadTooLarge(_) => WopiError::TooLarge,
            _ => WopiError::Internal,
        }
    }
}

/// Resolve the token and check the member's rights on this file now.
async fn authorize(
    state: &AppState,
    file_id: Uuid,
    token: &str,
    write: bool,
) -> Result<(Grant, FileAccess), WopiError> {
    let grant = tokens::resolve(&state.valkey, token)
        .await?
        .ok_or(WopiError::Unauthorized)?;
    if grant.file_id != file_id || (write && grant.mode == Mode::View) {
        return Err(WopiError::Unauthorized);
    }
    let access = if write {
        authz::ensure_content_editable(&state.db, file_id, grant.user_id).await?
    } else {
        authz::ensure_readable(&state.db, file_id, grant.user_id).await?
    };
    Ok((grant, access))
}

fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap_or_default()
}

/// `CheckFileInfo`.
async fn check_file_info(
    State(state): State<AppState>,
    Path(file_id): Path<Uuid>,
    Query(access): Query<Access>,
) -> Result<Json<serde_json::Value>, WopiError> {
    let (grant, access) = authorize(&state, file_id, &access.access_token, false).await?;
    let file = access.file;
    let version = crate::files::download::current_version(&state.db, &file).await?;
    let can_write = grant.mode != Mode::View
        && authz::ensure_content_editable(&state.db, file_id, grant.user_id)
            .await
            .is_ok();
    // While a lock is held, the version the session started on (see `locks`).
    let (version_id, modified) = match locks::current(&state.valkey, file_id).await? {
        Some(held) => (held.version_id, held.modified_at),
        None => (version.id, rfc3339(version.created_at)),
    };
    let name = users::Entity::find_by_id(grant.user_id)
        .one(&state.db)
        .await?
        .map(|u| u.display_name)
        .unwrap_or_default();
    Ok(Json(json!({
        "BaseFileName": file.name,
        "Size": version.size_bytes,
        "OwnerId": file.owner_id.map(|id| id.to_string()).unwrap_or_default(),
        "UserId": grant.user_id.to_string(),
        "UserFriendlyName": name,
        "Version": version_id.to_string(),
        "LastModifiedTime": modified,
        "UserCanWrite": can_write,
        "ReadOnly": !can_write,
        "SupportsUpdate": true,
        "SupportsLocks": true,
        "SupportsGetLock": true,
        "SupportsExtendedLockLength": true,
        "UserCanNotWriteRelative": grant.mode != Mode::Convert,
        "SupportsRename": false,
        "UserCanRename": false,
        "PostMessageOrigin": state.config.public_base_url,
    })))
}

/// `GetFile`.
async fn get_file(
    State(state): State<AppState>,
    Path(file_id): Path<Uuid>,
    Query(access): Query<Access>,
) -> Result<Response, WopiError> {
    let (_, access) = authorize(&state, file_id, &access.access_token, false).await?;
    let storage = state.storage.as_ref().ok_or(WopiError::Internal)?;
    let version = crate::files::download::current_version(&state.db, &access.file).await?;
    let key = version.storage_key.ok_or(WopiError::NotFound)?;
    let bytes = storage.get(&key).await.map_err(|error| {
        tracing::error!(%error, "WOPI GetFile could not read the object store");
        WopiError::Internal
    })?;
    let mut response = bytes.into_response();
    if let Ok(value) = HeaderValue::from_str(&version.id.to_string()) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(ITEM_VERSION_HEADER), value);
    }
    Ok(response)
}

/// `PutFile`: a new version, if the lock matches.
async fn put_file(
    State(state): State<AppState>,
    Path(file_id): Path<Uuid>,
    Query(access): Query<Access>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, WopiError> {
    let (grant, access) = authorize(&state, file_id, &access.access_token, true).await?;
    let given = header(&headers, LOCK_HEADER);
    match locks::current(&state.valkey, file_id).await? {
        Some(held) if held.lock != given => return Err(WopiError::Conflict(held.lock)),
        None if access.file.size_bytes > 0 => return Err(WopiError::Conflict(String::new())),
        _ => {}
    }
    let dto = versions::add_version(&state, access.file, grant.user_id, &body).await?;
    let mut response = Json(json!({ "LastModifiedTime": dto.updated_at })).into_response();
    if let Some(Ok(value)) = dto
        .version_id
        .map(|id| HeaderValue::from_str(&id.to_string()))
    {
        response
            .headers_mut()
            .insert(HeaderName::from_static(ITEM_VERSION_HEADER), value);
    }
    Ok(response)
}

/// `POST /wopi/files/{id}`: the operation is named by `X-WOPI-Override`.
async fn file_operation(
    State(state): State<AppState>,
    Path(file_id): Path<Uuid>,
    Query(access): Query<Access>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, WopiError> {
    let operation = header(&headers, "x-wopi-override").to_ascii_uppercase();
    let lock = header(&headers, LOCK_HEADER).to_owned();
    match operation.as_str() {
        "LOCK" => {
            let (_, access) = authorize(&state, file_id, &access.access_token, true).await?;
            let version = crate::files::download::current_version(&state.db, &access.file).await?;
            let old = headers
                .get("x-wopi-oldlock")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty());
            let at = (version.id, rfc3339(version.created_at));
            lock_answer(locks::lock(&state.valkey, file_id, &lock, old, at).await?)
        }
        "REFRESH_LOCK" => {
            authorize(&state, file_id, &access.access_token, true).await?;
            lock_answer(locks::refresh(&state.valkey, file_id, &lock).await?)
        }
        "UNLOCK" => {
            authorize(&state, file_id, &access.access_token, true).await?;
            lock_answer(locks::unlock(&state.valkey, file_id, &lock).await?)
        }
        "GET_LOCK" => {
            authorize(&state, file_id, &access.access_token, false).await?;
            let current = locks::current(&state.valkey, file_id)
                .await?
                .map(|held| held.lock)
                .unwrap_or_default();
            let mut response = StatusCode::OK.into_response();
            if let Ok(value) = HeaderValue::from_str(&current) {
                response
                    .headers_mut()
                    .insert(HeaderName::from_static(LOCK_HEADER), value);
            }
            Ok(response)
        }
        "PUT_RELATIVE" => {
            put_relative(&state, file_id, &access.access_token, &headers, &body).await
        }
        _ => Err(WopiError::NotImplemented),
    }
}

/// `PutRelativeFile`, for the conversion of a legacy format only: the converted bytes become a new
/// file beside the original, which is never touched. The name is the original's with the target
/// extension, made free if taken. The suggested target's name part is ignored on purpose (WOPI
/// encodes it in UTF-7); only its extension is read.
async fn put_relative(
    state: &AppState,
    file_id: Uuid,
    token: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response, WopiError> {
    let (grant, access) = authorize(state, file_id, token, true).await?;
    if grant.mode != Mode::Convert {
        return Err(WopiError::NotImplemented);
    }
    let target = match header(headers, "x-wopi-suggestedtarget") {
        "" => header(headers, "x-wopi-relativetarget"),
        suggested => suggested,
    };
    let ext = target
        .rsplit('.')
        .next()
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.bytes().all(|b| b.is_ascii_alphanumeric()))
        .map(|e| e.to_ascii_lowercase())
        .ok_or(WopiError::BadRequest)?;
    let original = access.file;
    let stem = original
        .name
        .rsplit_once('.')
        .map_or(original.name.as_str(), |(stem, _)| stem);
    let name = versions::free_name(
        &state.db,
        original.space_id,
        original.parent_folder_id,
        original.conversation_id,
        stem,
        &ext,
    )
    .await?;
    let created = versions::create_file(
        state,
        versions::NewFile {
            space_id: original.space_id,
            folder_id: original.parent_folder_id,
            conversation_id: original.conversation_id,
            owner: grant.user_id,
            name,
        },
        body,
    )
    .await?;
    let (new_token, _) = tokens::mint(
        &state.valkey,
        grant.user_id,
        created.id,
        Mode::Edit,
        state.config.office_token_ttl_secs,
    )
    .await?;
    Ok(Json(json!({
        "Name": created.name,
        "Url": format!("{}/wopi/files/{}?access_token={new_token}", state.config.wopi_base_url, created.id),
    }))
    .into_response())
}

fn lock_answer(outcome: Outcome) -> Result<Response, WopiError> {
    match outcome {
        Outcome::Ok => Ok(StatusCode::OK.into_response()),
        Outcome::Conflict(current) => Err(WopiError::Conflict(current)),
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}
