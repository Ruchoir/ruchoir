//! Space creation.
//!
//! A space is the tenant boundary: everything else (channels, DMs, files, members) hangs off one.
//! Creating one is therefore the only endpoint in the messaging surface that needs no existing
//! membership, just a session. The creator becomes the space's `owner`.
//!
//! A new space is born with one public channel so it is usable immediately: a space with no
//! conversation is a dead end for the person who just created it.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{channel_members, channels, conversations, space_members, spaces};
use crate::state::AppState;

use super::dto::{CreateSpaceRequest, SpaceDto};
use super::error::ApiError;
use super::slug::{slugify, MAX_HANDLE_LEN};

/// The channel every new space starts with. Named like any other channel handle.
const DEFAULT_CHANNEL: &str = "general";

/// `POST /api/v1/spaces`: create a space owned by the caller.
#[utoipa::path(
    post,
    path = "/api/v1/spaces",
    tag = "messaging",
    request_body = CreateSpaceRequest,
    responses(
        (status = 201, description = "Space created", body = SpaceDto),
        (status = 400, description = "The name is empty or has no usable characters"),
        (status = 401, description = "No session")
    )
)]
pub async fn create_space(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<CreateSpaceRequest>,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_HANDLE_LEN {
        return Err(ApiError::BadRequest("a space needs a name"));
    }
    let base = slugify(name);
    if base.is_empty() {
        return Err(ApiError::BadRequest("this name has no usable characters"));
    }

    let space_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    // Slugs are unique across the workspace, so two spaces called "Atelier" get `atelier` and
    // `atelier-2`. Resolved inside the transaction, and the unique index stays the real guard.
    let slug = unique_slug(&txn, &base).await?;
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(name.to_owned()),
        slug: Set(slug.clone()),
        created_by: Set(Some(session.user_id)),
        icon_key: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(session.user_id),
        role: Set("owner".to_owned()),
        invited_by: Set(None),
        joined_at: Set(now),
    }
    .insert(&txn)
    .await?;

    // The starting channel. A channel row is the detail table of a conversation, so the
    // conversation comes first (the foreign key points at it).
    conversations::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    channels::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        name: Set(DEFAULT_CHANNEL.to_owned()),
        channel_type: Set("public".to_owned()),
        topic: Set(None),
        created_by: Set(Some(session.user_id)),
        archived_at: Set(None),
        imported_source: Set(None),
        external_ref: Set(None),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(session.user_id),
        role: Set("owner".to_owned()),
        notification_level: Set("all".to_owned()),
        muted: Set(false),
        favorite: Set(false),
        joined_at: Set(now),
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(SpaceDto {
            id: space_id,
            name: name.to_owned(),
            slug,
            role: "owner".to_owned(),
            members: 1,
            // A space one second old, holding one empty channel: both counters are zero by
            // construction, not by omission.
            unread: 0,
            mentions: 0,
            // Brand new, so nothing has been uploaded for it yet.
            icon_url: None,
        }),
    ))
}

/// The first free slug in the `base`, `base-2`, `base-3` ... series.
async fn unique_slug<C: ConnectionTrait>(db: &C, base: &str) -> Result<String, ApiError> {
    for suffix in 1..=50u32 {
        let candidate = if suffix == 1 {
            base.to_owned()
        } else {
            format!("{base}-{suffix}")
        };
        let taken = spaces::Entity::find()
            .filter(spaces::Column::Slug.eq(candidate.clone()))
            .one(db)
            .await?
            .is_some();
        if !taken {
            return Ok(candidate);
        }
    }
    Err(ApiError::BadRequest(
        "too many spaces share this name; choose another",
    ))
}
