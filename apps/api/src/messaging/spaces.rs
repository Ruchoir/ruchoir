//! The space lifecycle: creating one, renaming it, leaving it and deleting it.
//!
//! A space is the tenant boundary: everything else (channels, DMs, files, members) hangs off one.
//! Creating one is therefore the only endpoint in the messaging surface that needs no existing
//! membership, just a session. The creator becomes the space's `owner`.
//!
//! A new space is born with one public channel so it is usable immediately: a space with no
//! conversation is a dead end for the person who just created it.
//!
//! The two ways out are deliberately different operations. **Leaving** takes one membership away
//! and touches nothing else: the space carries on, and the person's messages stay where they were
//! written, because a conversation others took part in is not one member's to erase. **Deleting**
//! is the owner destroying the space itself, and it is immediate and total: rows go with the
//! cascade, stored objects are removed behind them, and nothing is kept for a grace period. A
//! product that sells control over one's own data does not get to hold on to data it was told to
//! destroy; what protects against a mistake here is the instance backup, not a hidden copy.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::IntoActiveModel;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_members, channels, conversations, file_versions, files, messages, space_members,
    space_slugs, spaces,
};
use crate::state::AppState;

use super::dto::{
    CreateSpaceRequest, SpaceDto, SpaceRefDto, SpaceRemovedDto, SpaceUpdatedDto, UpdateSpaceRequest,
};
use super::error::ApiError;
use super::slug::{slugify, MAX_HANDLE_LEN};
use crate::realtime::event::RealtimeEnvelope;

/// The channel every new space starts with. Named like any other channel handle.
const DEFAULT_CHANNEL: &str = "general";

/// The `system_event` discriminator written into the channel when someone leaves the space. The
/// counterpart of the invitation path's arrival notice, and like it, the client turns it into a
/// sentence: the database never stores one.
const LEFT_EVENT: &str = "member_left";

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

/// `DELETE /api/v1/spaces/{space_id}/membership`: leave a space.
///
/// Only the caller's own membership goes, here and in the channels of that space. What they wrote
/// stays: a channel is a shared record, and taking one member's messages out of it would rewrite
/// everyone else's history. Coming back needs a new invitation, which is what makes this worth a
/// confirmation on the way out rather than an undo afterwards.
///
/// **The last owner is refused.** An owner may walk out of a space that still has another owner;
/// the last one cannot, because the space would be left with nobody able to administer it, invite
/// into it or delete it. They are told to hand ownership over or to delete the space, which is a
/// `409`: the request is not malformed, the space is simply not in a state that allows it.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/membership",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 204, description = "The caller is no longer a member"),
        (status = 403, description = "Not a member of the space"),
        (status = 409, description = "The caller is the space's last owner")
    )
)]
pub async fn leave_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let membership = space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;

    if membership.role == "owner" {
        let owners = space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(space_id))
            .filter(space_members::Column::Role.eq("owner"))
            .count(&state.db)
            .await?;
        if owners <= 1 {
            return Err(ApiError::Conflict(
                "you are this space's last owner: make someone else an owner, or delete the space",
            ));
        }
    }

    // Read the roster while the caller is still on it: it is what the departure has to be announced
    // to, and one second later the query no longer authorises them to ask for it.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;

    let txn = state.db.begin().await?;
    let channel_ids: Vec<Uuid> = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(&txn)
        .await?
        .into_iter()
        .map(|channel| channel.id)
        .collect();
    // The channel memberships inside the space go with it. Leaving them would leave rows granting
    // access to private channels of a space the person is no longer in, which is the kind of
    // leftover that only surfaces the day someone is invited back.
    if !channel_ids.is_empty() {
        channel_members::Entity::delete_many()
            .filter(channel_members::Column::UserId.eq(session.user_id))
            .filter(channel_members::Column::ChannelId.is_in(channel_ids))
            .exec(&txn)
            .await?;
    }
    space_members::Entity::delete_by_id((space_id, session.user_id))
        .exec(&txn)
        .await?;

    // The departure notice, written where the arrival notice was: the space's oldest public
    // channel. A push scrolls away, the history stays, and a member list that silently loses a row
    // leaves the people who stayed with no idea when it happened. Like the arrival, the row holds
    // the event and no sentence.
    let notice = match super::invitations::first_public_channel(&txn, space_id).await? {
        Some(channel) => Some(
            messages::ActiveModel {
                id: Set(Uuid::new_v4()),
                conversation_id: Set(channel),
                author_id: Set(Some(session.user_id)),
                kind: Set("system".to_owned()),
                system_event: Set(Some(LEFT_EVENT.to_owned())),
                created_at: Set(OffsetDateTime::now_utc()),
                ..Default::default()
            }
            .insert(&txn)
            .await?,
        ),
        None => None,
    };
    txn.commit().await?;

    announce_departure(&state, space_id, session.user_id, audience).await;
    if let Some(notice) = notice {
        publish_notice(&state, session.user_id, notice).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Send a freshly written system message to the channel it belongs to. It travels as an ordinary
/// `message.created`, so every client that renders a message renders this one with no new case.
async fn publish_notice(
    state: &AppState,
    actor: Uuid,
    notice: messages::Model,
) -> Result<(), ApiError> {
    let conversation_id = notice.conversation_id;
    let audience: Vec<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(conversation_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|member| member.user_id)
        .collect();
    if audience.is_empty() {
        return Ok(());
    }
    if let Some(dto) = super::messages::hydrate_messages(&state.db, actor, vec![notice])
        .await?
        .pop()
    {
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::message_created(conversation_id, dto),
            )
            .await;
    }
    Ok(())
}

/// `DELETE /api/v1/spaces/{space_id}`: delete a space and everything in it. Owner only.
///
/// Not open to an admin: an admin manages who is in a space and what it looks like, and destroying
/// it is a different kind of act. Everything in the schema hangs off the space with a cascading
/// foreign key, so one row deletion takes the channels, messages, memberships, invitations, file
/// records and address history with it. The stored objects are not in the database, so they are
/// collected first and removed behind the transaction: without that step, deleting a space would
/// leave its files sitting in the object store while the interface reported them gone.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 204, description = "The space and everything in it are gone"),
        (status = 403, description = "Not the owner of the space")
    )
)]
pub async fn delete_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    match space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
    {
        Some(membership) if membership.role == "owner" => {}
        _ => return Err(ApiError::Forbidden),
    }
    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;

    // Both read before the cascade removes the rows that name them.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;
    let mut keys = stored_object_keys(&state, space_id).await?;
    keys.extend(space.icon_key);

    spaces::Entity::delete_by_id(space_id)
        .exec(&state.db)
        .await?;

    forget_objects(&state, keys).await;
    let removed = SpaceRemovedDto {
        space_id,
        deleted: true,
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::space_removed(&removed))
        .await;
    crate::realtime::presence::refresh_and_broadcast(&state, session.user_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Tell the space that someone walked out of it, and tell them that it is no longer theirs.
///
/// Two events because they say two different things to two different audiences: the people staying
/// need the roster corrected, the person leaving needs the space off their rail (in every tab they
/// have open, not only the one they clicked in). Best-effort, like every other push: the membership
/// is already gone, and a delivery problem must not turn that into a failed request.
async fn announce_departure(state: &AppState, space_id: Uuid, user_id: Uuid, audience: Vec<Uuid>) {
    let staying: Vec<Uuid> = audience.into_iter().filter(|id| *id != user_id).collect();
    if !staying.is_empty() {
        let left = super::dto::MemberLeftDto { space_id, user_id };
        state
            .hub
            .publish(staying, RealtimeEnvelope::member_left(&left))
            .await;
    }
    let removed = SpaceRemovedDto {
        space_id,
        deleted: false,
    };
    state
        .hub
        .publish(vec![user_id], RealtimeEnvelope::space_removed(&removed))
        .await;
    // The set of people this person shares a space with just shrank, and the presence fan-out
    // freezes its audience when a socket opens. Same call the invitation path makes on the way in.
    crate::realtime::presence::refresh_and_broadcast(state, user_id).await;
}

/// Every object key a space's files occupy: the bytes of each version, and the thumbnails derived
/// from the image ones. Soft-deleted files are included on purpose: their rows are about to go for
/// good, so this is the last moment their bytes can be named.
async fn stored_object_keys(state: &AppState, space_id: Uuid) -> Result<Vec<String>, ApiError> {
    let file_ids: Vec<Uuid> = files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|file| file.id)
        .collect();
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let versions = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.is_in(file_ids))
        .all(&state.db)
        .await?;
    let mut keys = Vec::with_capacity(versions.len());
    for version in versions {
        keys.extend(version.storage_key);
        keys.extend(version.thumbnail_key);
    }
    Ok(keys)
}

/// Remove objects whose records are gone. A failure leaks one object and is logged rather than
/// raised: the deletion it belongs to has already been committed, and there is nothing left to
/// undo it with.
async fn forget_objects(state: &AppState, keys: Vec<String>) {
    let Some(storage) = state.storage.as_ref() else {
        return;
    };
    for key in keys {
        if let Err(error) = storage.delete(&key).await {
            tracing::warn!(%error, "could not delete an object of a deleted space");
        }
    }
}
