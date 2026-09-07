//! Account avatars and space icons: small images with their own lifecycle.
//!
//! Deliberately not `files` rows. A `files` row belongs to a space (`space_id` is `NOT NULL`, and it
//! is in every file authorization query), while an avatar belongs to an account and is visible to
//! anyone that account shares a space with. It is also one image, replaced rather than versioned,
//! that belongs in nobody's file tree. Bending the file model to hold it would cost more than
//! keeping it apart.
//!
//! So each lives under its own object-store key, recorded in `users.avatar_key` /
//! `spaces.icon_key`. The key carries a fresh id on every upload, so the URL changes with the image
//! and no cache anywhere has to be told about it; the old object is deleted once the new key is
//! committed.
//!
//! Bytes are never served back as they arrived: an upload is decoded, cropped to its largest centred
//! square, bounded to a known size and re-encoded, so what a browser renders is always something this
//! server produced rather than a file someone handed it, and it is always the shape it will be shown
//! in. The client offers its own crop before uploading, which decides *which* square; this decides
//! that there is one, including for a client that skipped that step.
//!
//! Transparency survives: a space icon is usually a logo meant to sit on the rail's own colour, so an
//! image carrying alpha is stored as PNG rather than flattened onto a background. The key records the
//! extension, which is how serving knows the content type without another column.

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{spaces, users};
use crate::messaging::authz as space_authz;
use crate::state::AppState;

use super::authz;
use super::error::FileError;
use super::thumbnail;

/// Longest side of a stored avatar or icon, in pixels. Large enough for a profile hero at twice the
/// device pixel ratio, small enough that these never behave like documents.
const IMAGE_MAX_PX: u32 = 512;

/// Ceiling on an upload before it is decoded, well under the general file limit: an avatar that
/// needs megabytes is a mistake, and decoding is the expensive part.
const IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// What an upload answers with: the new URL, so the client can show it without a round trip.
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct ImageRef {
    /// Same-origin URL of the stored image, versioned by its key.
    pub url: String,
}

/// `PUT /api/v1/users/me/avatar`: replace the caller's own avatar.
#[utoipa::path(
    put,
    path = "/api/v1/users/me/avatar",
    tag = "files",
    request_body(content = String, description = "multipart/form-data: file", content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "Avatar stored", body = ImageRef),
        (status = 400, description = "Missing or undecodable image"),
        (status = 413, description = "Image too large"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn set_my_avatar(
    State(state): State<AppState>,
    session: AuthSession,
    multipart: Multipart,
) -> Result<Json<ImageRef>, FileError> {
    let user = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or(FileError::Forbidden)?;
    let previous = user.avatar_key.clone();

    let key = store_image(
        &state,
        &format!("avatars/users/{}", session.user_id),
        multipart,
    )
    .await?;
    let url = avatar_url(session.user_id, &key);
    let mut active = user.into_active_model();
    active.avatar_key = Set(Some(key));
    let updated = active.update(&state.db).await?;
    forget_object(&state, previous).await;
    // Everyone who shares a space draws this face; without the announcement they keep the previous
    // one until they reload, which looks like the upload having been lost.
    crate::messaging::users::broadcast_profile_change(&state, &updated).await;

    Ok(Json(ImageRef { url }))
}

/// `DELETE /api/v1/users/me/avatar`: fall back to the generated avatar.
#[utoipa::path(
    delete,
    path = "/api/v1/users/me/avatar",
    tag = "files",
    responses((status = 204, description = "Avatar removed"))
)]
pub async fn clear_my_avatar(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<StatusCode, FileError> {
    let user = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or(FileError::Forbidden)?;
    let previous = user.avatar_key.clone();
    let mut active = user.into_active_model();
    active.avatar_key = Set(None);
    let updated = active.update(&state.db).await?;
    forget_object(&state, previous).await;
    crate::messaging::users::broadcast_profile_change(&state, &updated).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/users/{user_id}/avatar`: an account's avatar bytes.
///
/// Readable by anyone who shares a space with that account, which is the same audience that already
/// sees their name and presence. A `404` covers both "no avatar" and "not someone you share a space
/// with", so the endpoint never confirms an account exists to a stranger.
#[utoipa::path(
    get,
    path = "/api/v1/users/{user_id}/avatar",
    tag = "files",
    params(("user_id" = Uuid, Path, description = "User id")),
    responses(
        (status = 200, description = "Avatar bytes"),
        (status = 404, description = "No avatar, or not a co-member")
    )
)]
pub async fn get_avatar(
    State(state): State<AppState>,
    session: AuthSession,
    Path(user_id): Path<Uuid>,
) -> Result<Response, FileError> {
    if user_id != session.user_id {
        let co_members = space_authz::space_co_members(&state.db, session.user_id)
            .await
            .map_err(|_| FileError::Internal)?;
        if !co_members.contains(&user_id) {
            return Err(FileError::NotFound);
        }
    }
    let key = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .and_then(|user| user.avatar_key)
        .ok_or(FileError::NotFound)?;
    serve_object(&state, &key).await
}

/// `PUT /api/v1/spaces/{space_id}/icon`: replace a space's icon. Owner or admin only.
#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/icon",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body(content = String, description = "multipart/form-data: file", content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "Icon stored", body = ImageRef),
        (status = 400, description = "Missing or undecodable image"),
        (status = 403, description = "Not an owner or admin of the space")
    )
)]
pub async fn set_space_icon(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    multipart: Multipart,
) -> Result<Json<ImageRef>, FileError> {
    if !authz::is_space_admin(&state.db, space_id, session.user_id).await? {
        return Err(FileError::Forbidden);
    }
    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(FileError::NotFound)?;
    let previous = space.icon_key.clone();

    let key = store_image(&state, &format!("icons/spaces/{space_id}"), multipart).await?;
    let url = icon_url(space_id, &key);
    let mut active = space.into_active_model();
    active.icon_key = Set(Some(key));
    let updated = active.update(&state.db).await?;
    forget_object(&state, previous).await;
    // The whole space draws this mark; without the announcement everyone else keeps the previous
    // one until they reload, which looks like the upload having been lost.
    crate::messaging::spaces::broadcast_space_change(&state, &updated, session.user_id).await;

    Ok(Json(ImageRef { url }))
}

/// `DELETE /api/v1/spaces/{space_id}/icon`: fall back to the generated mark. Owner or admin only.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/icon",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 204, description = "Icon removed"),
        (status = 403, description = "Not an owner or admin of the space")
    )
)]
pub async fn clear_space_icon(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<StatusCode, FileError> {
    if !authz::is_space_admin(&state.db, space_id, session.user_id).await? {
        return Err(FileError::Forbidden);
    }
    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(FileError::NotFound)?;
    let previous = space.icon_key.clone();
    let mut active = space.into_active_model();
    active.icon_key = Set(None);
    let updated = active.update(&state.db).await?;
    forget_object(&state, previous).await;
    crate::messaging::spaces::broadcast_space_change(&state, &updated, session.user_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/spaces/{space_id}/icon`: a space's icon bytes, for its members.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/icon",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Icon bytes"),
        (status = 404, description = "No icon, or not a member")
    )
)]
pub async fn get_space_icon(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Response, FileError> {
    if authz::ensure_space_member(&state.db, space_id, session.user_id)
        .await
        .is_err()
    {
        return Err(FileError::NotFound);
    }
    let key = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .and_then(|space| space.icon_key)
        .ok_or(FileError::NotFound)?;
    serve_object(&state, &key).await
}

/// Same-origin URL of an account's avatar. Built here so one definition serves every DTO.
pub fn avatar_url(user_id: Uuid, key: &str) -> String {
    format!("/api/v1/users/{user_id}/avatar?v={}", version_of(key))
}

/// Same-origin URL of a space's icon.
pub fn icon_url(space_id: Uuid, key: &str) -> String {
    format!("/api/v1/spaces/{space_id}/icon?v={}", version_of(key))
}

/// A short version tag derived from the object key.
///
/// The path itself cannot carry it: an avatar is addressed by its owner's id, which never changes,
/// so with a stable URL and a cache lifetime the browser would keep showing the previous picture for
/// an hour after a replacement. The key ends in a fresh id on every upload, so a slice of it is
/// exactly the "this is a different image" signal the URL needs.
fn version_of(key: &str) -> &str {
    let stem = key.rsplit('/').next().unwrap_or(key);
    let stem = stem.split('.').next().unwrap_or(stem);
    &stem[stem.len().saturating_sub(8)..]
}

/// Read one image out of a multipart body, normalise it, store it, and return its new key.
///
/// The key ends in a fresh id, so replacing an image never reuses a path a client may have cached.
async fn store_image(
    state: &AppState,
    prefix: &str,
    mut multipart: Multipart,
) -> Result<String, FileError> {
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;

    let mut data: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| FileError::BadRequest("malformed multipart body"))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| FileError::BadRequest("could not read the uploaded image"))?;
            if bytes.len() > IMAGE_MAX_BYTES {
                return Err(FileError::PayloadTooLarge("this image is too large"));
            }
            data = Some(bytes.to_vec());
        }
    }
    let data = data.ok_or(FileError::BadRequest("no image in the request"))?;

    // Decoded and re-encoded rather than stored as received: nothing a browser renders comes
    // straight from an upload, and the result is a known format at a known size. An undecodable
    // upload fails here, which is also the only type check these endpoints need.
    let squared = thumbnail::square(&data, IMAGE_MAX_PX)
        .map_err(|_| FileError::BadRequest("this file is not a usable image"))?;

    // The extension is carried in the key so serving can derive the content type back without
    // storing it anywhere: the key is the only thing the row holds.
    let key = format!("{prefix}/{}.{}", Uuid::new_v4().simple(), squared.extension);
    storage
        .put(&key, &squared.bytes, squared.mime)
        .await
        .map_err(|_| FileError::Storage)?;
    Ok(key)
}

/// Stream a stored image back, cached briefly: the URL changes whenever the image does, so a short
/// cache costs nothing and a long one would only matter if the URL were stable, which it is not.
async fn serve_object(state: &AppState, key: &str) -> Result<Response, FileError> {
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let object = storage.get(key).await.map_err(|_| FileError::Storage)?;
    // Derived from the key's own extension, which `store_image` put there for exactly this.
    let mime = if key.ends_with(".png") {
        "image/png"
    } else {
        thumbnail::THUMBNAIL_MIME
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_owned()),
            // A year, and immutable: the URL carries a version derived from the object key, which
            // is freshly generated on every upload, so this exact URL can never answer with
            // different bytes. An hour of freshness meant re-fetching every avatar on the first
            // page view of each session, and a photo arriving half a second after the generated
            // one it replaces is seen as a flicker. Private: the bytes are only for people who
            // share a space, so no shared cache may hold them.
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_owned(),
            ),
        ],
        Body::from(object),
    )
        .into_response())
}

/// Delete the object a record no longer points at. A failure here leaks one object and must never
/// fail the request that already succeeded, so it is logged and dropped.
async fn forget_object(state: &AppState, key: Option<String>) {
    let (Some(key), Some(storage)) = (key, state.storage.as_ref()) else {
        return;
    };
    if let Err(error) = storage.delete(&key).await {
        tracing::warn!(%error, "could not delete a replaced image object");
    }
}
