//! Space creation.
//!
//! A space is the tenant boundary: everything else (channels, DMs, files, members) hangs off one.
//! Creating one is therefore the only endpoint in the messaging surface that needs no existing
//! membership, just a session. The creator becomes the space's `owner`.
//!
//! A new space is born with one public channel so it is usable immediately: a space with no
//! conversation is a dead end for the person who just created it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::IntoActiveModel;
use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, TransactionTrait};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_members, channels, conversations, space_members, space_slugs, spaces,
};
use crate::state::AppState;

use super::dto::{CreateSpaceRequest, SpaceDto, SpaceRefDto, SpaceUpdatedDto, UpdateSpaceRequest};
use super::error::ApiError;
use super::slug::{slugify, MAX_HANDLE_LEN};
use crate::realtime::event::RealtimeEnvelope;

/// The channel every new space starts with. Named like any other channel handle.
const DEFAULT_CHANNEL: &str = "general";

/// Announce a changed space to its members.
///
/// A space's name and mark are drawn by the rail, the mobile top bar, the switcher and the sidebar
/// header, all fed by a list loaded when the client signed in. Without this the change reaches
/// everyone else only on their next reload, which is how a new icon looks like it did not save.
///
/// Best-effort: a delivery problem must not fail the write that already succeeded.
///
/// `actor` is the member who made the change, needed only to authorise reading the roster: they are
/// in the audience too, so their own other tabs follow.
pub async fn broadcast_space_change(state: &AppState, space: &spaces::Model, actor: Uuid) {
    let Ok(audience) = super::authz::space_member_ids(&state.db, space.id, actor).await else {
        return;
    };
    let payload = SpaceUpdatedDto {
        id: space.id,
        name: space.name.clone(),
        slug: space.slug.clone(),
        icon_url: space
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(space.id, key)),
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::space_updated(&payload))
        .await;
}

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

    let txn = state.db.begin().await?;
    let (space_id, slug) = create_owned_space(&txn, name, session.user_id).await?;
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

/// Create a space owned by `owner`, born with one public channel, and return its id and slug.
///
/// Shared by the endpoint above and the `bootstrap` subcommand, so "a space is never an empty
/// shell" holds wherever a space comes from rather than only where someone remembered it.
pub(crate) async fn create_owned_space<C: ConnectionTrait>(
    txn: &C,
    name: &str,
    owner: Uuid,
) -> Result<(Uuid, String), ApiError> {
    let space_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();

    // Slugs are unique across the workspace, so two spaces called "Atelier" get `atelier` and
    // `atelier-2`. Resolved inside the caller's transaction, and the unique index stays the real
    // guard.
    let slug = unique_slug(txn, &slugify(name)).await?;
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(name.to_owned()),
        slug: Set(slug.clone()),
        created_by: Set(Some(owner)),
        icon_key: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await?;
    // The address is recorded after the space exists, not before: `space_slugs.space_id` points at
    // `spaces.id` and the constraint is checked immediately, so the other order made every single
    // space creation fail on a foreign key. It had gone unnoticed because the only two spaces on the
    // instance predate the address history.
    remember_slug(txn, space_id, &slug).await?;
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(owner),
        role: Set("owner".to_owned()),
        invited_by: Set(None),
        joined_at: Set(now),
    }
    .insert(txn)
    .await?;

    // The starting channel. A channel row is the detail table of a conversation, so the
    // conversation comes first (the foreign key points at it).
    conversations::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(now),
    }
    .insert(txn)
    .await?;
    channels::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        name: Set(DEFAULT_CHANNEL.to_owned()),
        channel_type: Set("public".to_owned()),
        topic: Set(None),
        created_by: Set(Some(owner)),
        archived_at: Set(None),
        imported_source: Set(None),
        external_ref: Set(None),
        created_at: Set(now),
    }
    .insert(txn)
    .await?;
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(owner),
        role: Set("owner".to_owned()),
        notification_level: Set("all".to_owned()),
        muted: Set(false),
        favorite: Set(false),
        joined_at: Set(now),
    }
    .insert(txn)
    .await?;

    Ok((space_id, slug))
}

/// The first free slug in the `base`, `base-2`, `base-3` ... series.
async fn unique_slug<C: ConnectionTrait>(db: &C, base: &str) -> Result<String, ApiError> {
    for suffix in 1..=50u32 {
        let candidate = if suffix == 1 {
            base.to_owned()
        } else {
            format!("{base}-{suffix}")
        };
        // Against the history, not against the spaces in use: a slug a renamed space used to answer
        // to still resolves to it, so handing it to a new space would hijack every link shared for
        // the old one.
        let taken = space_slugs::Entity::find_by_id(candidate.clone())
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

/// Record a slug as one this space answers to, now and for good.
///
/// Never deleted, including when the space moves off it: the whole point is that an address already
/// shared keeps arriving.
async fn remember_slug<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    slug: &str,
) -> Result<(), ApiError> {
    space_slugs::ActiveModel {
        slug: Set(slug.to_owned()),
        space_id: Set(space_id),
        created_at: NotSet,
    }
    .insert(db)
    .await?;
    Ok(())
}

/// `PATCH /api/v1/spaces/{space_id}`: rename a space. Owner or admin only.
///
/// The slug follows the name, and the one it leaves behind keeps working: every slug a space has
/// ever answered to is kept, and resolves to it forever. That is what lets the address stay honest
/// (it reads like the space is called) without breaking the bookmarks and links people already hold.
/// A slug is only minted when it is free in that whole history, so a retired address can never be
/// handed to another space.
#[utoipa::path(
    patch,
    path = "/api/v1/spaces/{space_id}",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = UpdateSpaceRequest,
    responses(
        (status = 200, description = "The space's new shared identity", body = SpaceUpdatedDto),
        (status = 400, description = "Empty or over-long name"),
        (status = 403, description = "Not an owner or admin of the space")
    )
)]
pub async fn update_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<UpdateSpaceRequest>,
) -> Result<Json<SpaceUpdatedDto>, ApiError> {
    super::authz::ensure_space_admin(&state.db, space_id, session.user_id).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_HANDLE_LEN {
        return Err(ApiError::BadRequest("a space needs a name"));
    }

    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // A rename that does not change the derived handle (capitalisation, punctuation) leaves the slug
    // alone: there is nothing to move, and minting `atelier-2` for it would be absurd.
    let txn = state.db.begin().await?;
    let wanted = slugify(name);
    let slug = if wanted.is_empty() || wanted == space.slug {
        space.slug.clone()
    } else {
        let fresh = unique_slug(&txn, &wanted).await?;
        remember_slug(&txn, space_id, &fresh).await?;
        fresh
    };
    let mut active = space.into_active_model();
    active.name = Set(name.to_owned());
    active.slug = Set(slug);
    active.updated_at = Set(OffsetDateTime::now_utc());
    let updated = active.update(&txn).await?;
    txn.commit().await?;

    broadcast_space_change(&state, &updated, session.user_id).await;
    Ok(Json(SpaceUpdatedDto {
        id: updated.id,
        name: updated.name.clone(),
        slug: updated.slug.clone(),
        icon_url: updated
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(updated.id, key)),
    }))
}

/// `GET /api/v1/spaces/by-slug/{slug}`: which space an address names, current or retired.
///
/// The client addresses a space by slug and holds its own list, so it only needs this when the slug
/// in an address matches nothing it knows: a link written before a rename. The answer carries the
/// current slug so the caller can correct the address it was opened with.
///
/// A `404` covers both "no such slug" and "not a space you are in", so this cannot be used to
/// discover which spaces exist on an instance.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/by-slug/{slug}",
    tag = "messaging",
    params(("slug" = String, Path, description = "A slug the space answers to, current or retired")),
    responses(
        (status = 200, description = "The space this slug leads to", body = SpaceRefDto),
        (status = 404, description = "Unknown slug, or not a space the caller belongs to")
    )
)]
pub async fn resolve_space_slug(
    State(state): State<AppState>,
    session: AuthSession,
    Path(slug): Path<String>,
) -> Result<Json<SpaceRefDto>, ApiError> {
    let alias = space_slugs::Entity::find_by_id(slug.to_lowercase())
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if !super::authz::is_space_member(&state.db, alias.space_id, session.user_id).await? {
        return Err(ApiError::NotFound);
    }
    let space = spaces::Entity::find_by_id(alias.space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(SpaceRefDto {
        id: space.id,
        slug: space.slug,
    }))
}
