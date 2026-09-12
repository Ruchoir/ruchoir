//! Space invitations: issuing them, listing them, revoking them, and accepting one.
//!
//! This is how an account other than a space's creator gets into it. Creating a space makes the
//! caller its owner; everyone else arrives through here.
//!
//! The token is 256 bits of CSPRNG output. Only its SHA-256 digest is stored (see
//! [`crate::auth::tokens::digest`]), so the row cannot be turned back into a working link: the raw
//! value is returned once, in the creation response, and embedded in the invitation email. Losing
//! it means revoking the invitation and issuing another, which is a click.
//!
//! Two shapes share one table and one code path. An invitation carrying an `email` is addressed to
//! one person, defaults to a single use, and checks the address on acceptance so that forwarding
//! the message does not hand over the space. One without an address is a shareable link, unlimited
//! by default; holding it is the authorization, which is the point of a link.
//!
//! Issuing, listing and revoking need an `owner` or `admin` role in the space. Reading a preview
//! needs no session at all: whoever opens the link has to see which space they are being invited to
//! before deciding to create an account.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, TransactionTrait,
};
use std::collections::HashMap;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::auth::tokens;
use crate::entities::{
    channel_members, channels, messages, space_invitations, space_members, spaces, users,
};
use crate::state::AppState;

use super::authz::{ensure_space_admin, space_member_ids};
use super::dto::{
    rfc3339, CreateInvitationRequest, CreatedInvitationDto, InvitationDto, InvitationPreviewDto,
    MemberDto, MemberJoinedDto, SpaceDto,
};
use super::error::ApiError;
use super::messages::hydrate_messages;
use crate::realtime::event::RealtimeEnvelope;

/// Default lifetime of an invitation: long enough to survive a weekend and a holiday, short enough
/// that a forgotten link stops working on its own.
const DEFAULT_TTL_HOURS: i64 = 24 * 7;

/// Longest lifetime an invitation may be given. A link that never really expires is a standing key
/// to the space, so the ceiling is deliberate rather than advisory.
const MAX_TTL_HOURS: i64 = 24 * 30;

/// Length of a token in its hex form (32 bytes).
const TOKEN_LEN: usize = 64;

/// The `system_event` discriminator written into the channel when someone joins. The client turns it
/// into a sentence; the database never stores one.
const JOINED_EVENT: &str = "member_joined";

/// `POST /api/v1/spaces/{space_id}/invitations`: issue an invitation into a space.
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/invitations",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateInvitationRequest,
    responses(
        (status = 201, description = "Invitation created; the link is returned once", body = CreatedInvitationDto),
        (status = 400, description = "Invalid address, role, lifetime or use count"),
        (status = 403, description = "Not an owner or admin of the space")
    )
)]
pub async fn create_invitation(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateInvitationRequest>,
) -> Result<(StatusCode, Json<CreatedInvitationDto>), ApiError> {
    ensure_space_admin(&state.db, space_id, session.user_id).await?;

    let email = match body.email.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(address) => Some(validate_email(address)?.to_owned()),
    };
    // `owner` is absent on purpose: ownership is transferred, never granted by a link.
    let role = match body.role.as_deref().unwrap_or("member") {
        "admin" => "admin",
        "member" => "member",
        "guest" => "guest",
        _ => {
            return Err(ApiError::BadRequest(
                "an invitation grants admin, member or guest",
            ))
        }
    };
    let ttl_hours = body.expires_in_hours.unwrap_or(DEFAULT_TTL_HOURS);
    if !(1..=MAX_TTL_HOURS).contains(&ttl_hours) {
        return Err(ApiError::BadRequest(
            "an invitation lasts between one hour and 30 days",
        ));
    }
    // An addressed invitation is for one person, so one use; a link is open unless capped.
    let max_uses = match body.max_uses {
        Some(max) if max < 1 => {
            return Err(ApiError::BadRequest("an invitation needs at least one use"))
        }
        Some(max) => Some(max),
        None if email.is_some() => Some(1),
        None => None,
    };

    let raw = tokens::generate_token().map_err(|_| ApiError::Internal)?;
    let now = OffsetDateTime::now_utc();
    let record = space_invitations::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(space_id),
        token_hash: Set(tokens::digest(&raw)),
        email: Set(email.clone()),
        role: Set(role.to_owned()),
        created_by: Set(Some(session.user_id)),
        max_uses: Set(max_uses),
        uses: Set(0),
        expires_at: Set(Some(now + Duration::hours(ttl_hours))),
        revoked_at: Set(None),
        created_at: Set(now),
    }
    .insert(&state.db)
    .await?;

    let base = state.mailer.base_url.trim_end_matches('/');
    let url = format!("{base}/invite?token={raw}");

    // The row is committed before the email is attempted: a relay failure must not lose an
    // invitation the administrator can still hand over by copying the link, so it is reported
    // rather than rolled back.
    let emailed = match &email {
        // In the inviter's language: the recipient has no account yet, so nothing is known about
        // what they read, and the person who just typed their address presumably shares a working
        // language with them.
        Some(address) => {
            send_invitation_email(&state, address, space_id, &url, session.user_id).await
        }
        None => false,
    };

    let inviter = display_name(&state, Some(session.user_id)).await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedInvitationDto {
            invitation: to_dto(&record, inviter, now),
            url,
            emailed,
        }),
    ))
}

/// `GET /api/v1/spaces/{space_id}/invitations`: what is outstanding for this space.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/invitations",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Invitations, newest first", body = [InvitationDto]),
        (status = 403, description = "Not an owner or admin of the space")
    )
)]
pub async fn list_invitations(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<InvitationDto>>, ApiError> {
    ensure_space_admin(&state.db, space_id, session.user_id).await?;

    let records = space_invitations::Entity::find()
        .filter(space_invitations::Column::SpaceId.eq(space_id))
        .order_by_desc(space_invitations::Column::CreatedAt)
        .all(&state.db)
        .await?;

    let inviter_ids: Vec<Uuid> = records.iter().filter_map(|r| r.created_by).collect();
    let names: HashMap<Uuid, String> = if inviter_ids.is_empty() {
        HashMap::new()
    } else {
        users::Entity::find()
            .filter(users::Column::Id.is_in(inviter_ids))
            .all(&state.db)
            .await?
            .into_iter()
            .map(|u| (u.id, u.display_name))
            .collect()
    };

    let now = OffsetDateTime::now_utc();
    let out = records
        .iter()
        .map(|record| {
            let inviter = record.created_by.and_then(|id| names.get(&id)).cloned();
            to_dto(record, inviter, now)
        })
        .collect();
    Ok(Json(out))
}

/// `DELETE /api/v1/spaces/{space_id}/invitations/{invitation_id}`: stop accepting an invitation.
///
/// Idempotent, and it keeps the original revocation stamp: revoking twice is not an event.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/invitations/{invitation_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("invitation_id" = Uuid, Path, description = "Invitation id")
    ),
    responses(
        (status = 204, description = "Invitation revoked"),
        (status = 403, description = "Not an owner or admin of the space"),
        (status = 404, description = "No such invitation in this space")
    )
)]
pub async fn revoke_invitation(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, invitation_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    ensure_space_admin(&state.db, space_id, session.user_id).await?;

    let record = space_invitations::Entity::find_by_id(invitation_id)
        .one(&state.db)
        .await?
        .filter(|record| record.space_id == space_id)
        .ok_or(ApiError::NotFound)?;

    if record.revoked_at.is_none() {
        let mut active = record.into_active_model();
        active.revoked_at = Set(Some(OffsetDateTime::now_utc()));
        active.update(&state.db).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/invitations/{token}`: what this invitation is, before signing in.
///
/// Deliberately unauthenticated: someone who has just received a link has no session yet, and has
/// to see which space they are joining to decide whether to create an account. Unknown, revoked,
/// expired and exhausted tokens all answer `404`, so the reason is never disclosed.
#[utoipa::path(
    get,
    path = "/api/v1/invitations/{token}",
    tag = "messaging",
    params(("token" = String, Path, description = "Invitation token")),
    responses(
        (status = 200, description = "The invitation", body = InvitationPreviewDto),
        (status = 404, description = "Unknown, revoked, expired or exhausted")
    )
)]
pub async fn preview_invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<InvitationPreviewDto>, ApiError> {
    let record = usable_invitation(&state, &token).await?;
    let space = spaces::Entity::find_by_id(record.space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;

    Ok(Json(InvitationPreviewDto {
        space_name: space.name,
        invited_by: display_name(&state, record.created_by).await?,
        email: record.email.clone(),
        role: record.role.clone(),
    }))
}

/// `POST /api/v1/invitations/{token}/accept`: join the space this invitation names.
///
/// Idempotent for an account that is already a member: it gets the space back and burns no use, so
/// a double click or a re-opened link changes nothing.
#[utoipa::path(
    post,
    path = "/api/v1/invitations/{token}/accept",
    tag = "messaging",
    params(("token" = String, Path, description = "Invitation token")),
    responses(
        (status = 200, description = "The space now joined", body = SpaceDto),
        (status = 401, description = "No session"),
        (status = 403, description = "The invitation is addressed to another account"),
        (status = 404, description = "Unknown, revoked, expired or exhausted")
    )
)]
pub async fn accept_invitation(
    State(state): State<AppState>,
    session: AuthSession,
    Path(token): Path<String>,
) -> Result<Json<SpaceDto>, ApiError> {
    let record = usable_invitation(&state, &token).await?;

    let user = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    // An addressed invitation is for one person. Without this check, forwarding the email would
    // hand the space to whoever received it.
    if let Some(addressed) = record.email.as_deref() {
        if !addressed.eq_ignore_ascii_case(user.email.trim()) {
            return Err(ApiError::Forbidden);
        }
    }

    let existing = space_members::Entity::find_by_id((record.space_id, session.user_id))
        .one(&state.db)
        .await?;
    let already_member = existing.is_some();
    // The arrival notice written into the channel, when there was a real arrival and the space has a
    // public channel to write it in. Published after the commit, like every other message.
    let mut notice: Option<messages::Model> = None;
    let role = match existing {
        // Already in: return the space unchanged, and do not spend a use.
        Some(member) => member.role,
        None => {
            let now = OffsetDateTime::now_utc();
            let txn = state.db.begin().await?;
            space_members::ActiveModel {
                space_id: Set(record.space_id),
                user_id: Set(session.user_id),
                role: Set(record.role.clone()),
                invited_by: Set(record.created_by),
                joined_at: Set(now),
            }
            .insert(&txn)
            .await?;

            let mut active = record.clone().into_active_model();
            active.uses = Set(record.uses + 1);
            active.update(&txn).await?;

            // A member who has joined no channel receives no real-time message, so the space would
            // look dead until they clicked into one. Joining the space's first public channel (the
            // `general` every space is born with) makes it live immediately.
            if let Some(channel) = first_public_channel(&txn, record.space_id).await? {
                channel_members::ActiveModel {
                    channel_id: Set(channel),
                    user_id: Set(session.user_id),
                    role: Set("member".to_owned()),
                    notification_level: Set("all".to_owned()),
                    muted: Set(false),
                    favorite: Set(false),
                    joined_at: Set(now),
                }
                .insert(&txn)
                .await?;

                // A durable trace of the arrival, next to the ephemeral push: a notice scrolls away,
                // the history does not. The row carries the *event*, never a sentence: user-facing
                // copy belongs to the client here, exactly as it does for the API's error codes.
                // `author_id` is the person the notice is about, which is what lets the client name
                // them without a second lookup.
                notice = Some(
                    messages::ActiveModel {
                        id: Set(Uuid::new_v4()),
                        conversation_id: Set(channel),
                        author_id: Set(Some(session.user_id)),
                        kind: Set("system".to_owned()),
                        system_event: Set(Some(JOINED_EVENT.to_owned())),
                        created_at: Set(now),
                        ..Default::default()
                    }
                    .insert(&txn)
                    .await?,
                );
            }
            txn.commit().await?;
            record.role.clone()
        }
    };

    let space = spaces::Entity::find_by_id(record.space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    let members = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space.id))
        .count(&state.db)
        .await? as i64;

    // Tell the space someone arrived, so the member list, the mention candidates and the
    // direct-message candidates gain them without a reload. Only on a real arrival: an existing
    // member re-opening their link changed nothing and must not announce itself again.
    if !already_member {
        let audience = space_member_ids(&state.db, space.id, session.user_id).await?;
        let joined = MemberJoinedDto {
            space_id: space.id,
            member: MemberDto {
                user_id: user.id,
                display_name: user.display_name.clone(),
                title: user.title.clone(),
                role: role.clone(),
                is_bot: user.is_bot,
                avatar_url: user
                    .avatar_key
                    .as_deref()
                    .map(|key| crate::files::avatar_url(user.id, key)),
            },
        };
        state
            .hub
            .publish(audience, RealtimeEnvelope::member_joined(&joined))
            .await;

        // Re-announce their presence now that the membership exists.
        //
        // The transport announces presence when a connection opens, to the co-members the joiner had
        // *at that moment*. Someone arriving through an invitation opens their socket around the same
        // time as this handler writes the membership row, so that announcement can go out while they
        // still belong to no space and reach an audience of one: the space would then see them
        // offline until it reloaded and re-read the heartbeat. Recomputing the audience here fixes it
        // whichever way the race falls. If the socket connected first, the heartbeat is already there
        // and this delivers `active` to the right people; if it has not connected yet, this delivers
        // `offline` and the socket's own announcement follows with the audience now correct.
        crate::realtime::presence::refresh_and_broadcast(&state, session.user_id).await;
    }

    // The channel notice travels as an ordinary `message.created`, to the channel's members, so
    // every client that already renders a message renders this one with no new case.
    if let Some(notice) = notice {
        let conversation_id = notice.conversation_id;
        let audience: Vec<Uuid> = channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.eq(conversation_id))
            .all(&state.db)
            .await?
            .into_iter()
            .map(|member| member.user_id)
            .collect();
        if let Some(dto) = hydrate_messages(&state.db, session.user_id, vec![notice])
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
    }

    Ok(Json(SpaceDto {
        id: space.id,
        name: space.name,
        slug: space.slug,
        role,
        members,
        // Not computed here: entering a space always reloads `/me/spaces` straight after, which
        // carries the real figures. Counting them twice for one response would be waste.
        unread: 0,
        mentions: 0,
        icon_url: space
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(space.id, key)),
    }))
}

/// Resolve a raw token to an invitation that would be accepted right now.
///
/// The four ways an invitation can fail (unknown, revoked, expired, exhausted) collapse into one
/// `404`: telling someone which one applies tells them about a space they are not in.
async fn usable_invitation(
    state: &AppState,
    token: &str,
) -> Result<space_invitations::Model, ApiError> {
    // Cheap shape check first, so a pathological path segment never reaches the database.
    if token.len() != TOKEN_LEN || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::NotFound);
    }
    let record = space_invitations::Entity::find()
        .filter(space_invitations::Column::TokenHash.eq(tokens::digest(token)))
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;

    if is_usable(&record, OffsetDateTime::now_utc()) {
        Ok(record)
    } else {
        Err(ApiError::NotFound)
    }
}

/// Whether an invitation would be accepted at `now`: not revoked, not expired, uses left.
fn is_usable(record: &space_invitations::Model, now: OffsetDateTime) -> bool {
    record.revoked_at.is_none()
        && record.expires_at.is_none_or(|expiry| expiry > now)
        && record.max_uses.is_none_or(|max| record.uses < max)
}

/// The space's oldest public, non-archived channel: the one a new member is joined to.
async fn first_public_channel<C: sea_orm::ConnectionTrait>(
    db: &C,
    space_id: Uuid,
) -> Result<Option<Uuid>, ApiError> {
    Ok(channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .filter(channels::Column::ChannelType.eq("public"))
        .order_by_asc(channels::Column::CreatedAt)
        .one(db)
        .await?
        .map(|channel| channel.id))
}

/// The display name of an account, or `None` when it is gone (`created_by` is provenance only).
async fn display_name(state: &AppState, user_id: Option<Uuid>) -> Result<Option<String>, ApiError> {
    let Some(user_id) = user_id else {
        return Ok(None);
    };
    Ok(users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .map(|user| user.display_name))
}

/// Shape-check an address before it is stored and mailed. Deliberately minimal: the only authority
/// on whether an address exists is whether the message arrives.
fn validate_email(address: &str) -> Result<&str, ApiError> {
    let invalid = ApiError::BadRequest("this email address is not usable");
    if address.len() > 320 || address.chars().any(char::is_whitespace) {
        return Err(invalid);
    }
    match address.split_once('@') {
        Some((local, domain)) if !local.is_empty() && domain.contains('.') => Ok(address),
        _ => Err(invalid),
    }
}

/// Send the invitation email. Returns whether it went out; a relay failure is logged and reported,
/// never fatal, because the administrator can still hand over the link from the response.
async fn send_invitation_email(
    state: &AppState,
    address: &str,
    space_id: Uuid,
    url: &str,
    inviter: Uuid,
) -> bool {
    let space_name = match spaces::Entity::find_by_id(space_id).one(&state.db).await {
        Ok(Some(space)) => space.name,
        _ => "Ruchoir".to_owned(),
    };
    let locale = crate::auth::routes::account_locale(state, inviter).await;
    let message = crate::auth::mail_text::invitation(locale, &space_name, url);
    match state
        .mailer
        .send(address, &message.subject, message.body)
        .await
    {
        Ok(()) => true,
        Err(error) => {
            // The address is not secret to the administrator who typed it, but the link is: never
            // log the URL.
            tracing::warn!(%error, "could not send an invitation email");
            false
        }
    }
}

/// Build the listing shape. The token never appears here: only its digest is stored.
fn to_dto(
    record: &space_invitations::Model,
    invited_by: Option<String>,
    now: OffsetDateTime,
) -> InvitationDto {
    InvitationDto {
        id: record.id,
        space_id: record.space_id,
        email: record.email.clone(),
        role: record.role.clone(),
        invited_by,
        uses: record.uses,
        max_uses: record.max_uses,
        expires_at: record.expires_at.map(rfc3339),
        created_at: rfc3339(record.created_at),
        usable: is_usable(record, now),
    }
}
