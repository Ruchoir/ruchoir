//! Sharing a personal calendar: its owner opens it to someone they have a space in common with, at
//! one of three levels, changes the level or takes it back. Opening a share tells the person, in the
//! app only (`calendar_shared`); every change reloads their screens.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use super::authz::{self, ShareLevel};
use super::error::CalendarError;
use super::events::instant_text;
use crate::auth::extract::AuthSession;
use crate::auth::mail_text::Locale;
use crate::entities::{calendar_shares, calendars, notifications};
use crate::messaging::dto::NotificationDto;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

/// One person a calendar is shared with.
#[derive(Debug, Serialize, ToSchema)]
pub struct ShareDto {
    pub user_id: Uuid,
    pub name: String,
    /// `freebusy`, `read` or `write`.
    pub level: String,
    pub created_at: String,
}

/// The level a share opens.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ShareInput {
    /// `freebusy`, `read` or `write`.
    pub level: String,
}

#[derive(Debug, Deserialize)]
pub struct CandidatesQuery {
    #[serde(default)]
    pub q: String,
}

/// Someone a calendar may be shared with.
#[derive(Debug, Serialize, ToSchema)]
pub struct CandidateDto {
    pub user_id: Uuid,
    pub name: String,
}

/// What a share notification keeps of its calendar, as it was when the share opened.
#[derive(Debug, Serialize, Deserialize)]
struct SharedPayload {
    calendar_id: Uuid,
    calendar_name: String,
    level: String,
}

/// The caller's own personal calendar: `NotFound` when they cannot see it or do not own it,
/// `Invalid` for a space's calendar, which its space shares already.
async fn owned<C: ConnectionTrait>(
    db: &C,
    user: Uuid,
    calendar_id: Uuid,
) -> Result<calendars::Model, CalendarError> {
    let access = authz::seen(db, user, calendar_id).await?;
    if access.calendar.space_id.is_some() {
        return Err(CalendarError::Invalid(
            "A space's calendar is shared with its space already.",
        ));
    }
    if access.calendar.owner_user_id != Some(user) {
        return Err(CalendarError::NotFound);
    }
    Ok(access.calendar)
}

/// `GET /api/v1/calendars/{calendar_id}/shares`: whom the caller's calendar is shared with.
#[utoipa::path(
    get,
    path = "/api/v1/calendars/{calendar_id}/shares",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    responses(
        (status = 200, description = "Its shares", body = [ShareDto]),
        (status = 404, description = "Not the caller's calendar")
    )
)]
pub async fn list_shares(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
) -> Result<Json<Vec<ShareDto>>, CalendarError> {
    owned(&state.db, session.user_id, calendar_id).await?;
    let rows = calendar_shares::Entity::find()
        .filter(calendar_shares::Column::CalendarId.eq(calendar_id))
        .all(&state.db)
        .await?;
    let names = super::attendees::names(&state.db, rows.iter().map(|r| r.user_id)).await?;
    let mut shares: Vec<ShareDto> = rows
        .into_iter()
        .map(|row| ShareDto {
            name: names.get(&row.user_id).cloned().unwrap_or_default(),
            user_id: row.user_id,
            level: row.level,
            created_at: instant_text(row.created_at),
        })
        .collect();
    shares.sort_by_key(|s| s.name.to_lowercase());
    Ok(Json(shares))
}

/// `PUT /api/v1/calendars/{calendar_id}/shares/{user_id}`: open the calendar to someone, or change
/// how far.
#[utoipa::path(
    put,
    path = "/api/v1/calendars/{calendar_id}/shares/{user_id}",
    tag = "calendar",
    params(
        ("calendar_id" = Uuid, Path, description = "Calendar id"),
        ("user_id" = Uuid, Path, description = "The person")
    ),
    request_body = ShareInput,
    responses(
        (status = 204, description = "Shared"),
        (status = 404, description = "Not the caller's calendar"),
        (status = 422, description = "A space's calendar, oneself, no space in common, or an unknown level")
    )
)]
pub async fn put_share(
    State(state): State<AppState>,
    session: AuthSession,
    Path((calendar_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ShareInput>,
) -> Result<StatusCode, CalendarError> {
    let calendar = owned(&state.db, session.user_id, calendar_id).await?;
    let level = ShareLevel::parse(&body.level).ok_or(CalendarError::Invalid(
        "A share is freebusy, read or write.",
    ))?;
    if user_id == session.user_id {
        return Err(CalendarError::Invalid(
            "One's own calendar is one's own already.",
        ));
    }
    if !authz::share_a_space(&state.db, session.user_id, user_id).await? {
        return Err(CalendarError::Invalid(
            "A calendar is shared with someone of a space in common.",
        ));
    }
    let existing = calendar_shares::Entity::find_by_id((calendar_id, user_id))
        .one(&state.db)
        .await?;
    match existing {
        Some(row) => {
            let mut row: calendar_shares::ActiveModel = row.into();
            row.level = Set(level.as_str().to_owned());
            row.update(&state.db).await?;
        }
        None => {
            calendar_shares::ActiveModel {
                calendar_id: Set(calendar_id),
                user_id: Set(user_id),
                level: Set(level.as_str().to_owned()),
                created_by: Set(Some(session.user_id)),
                created_at: Set(OffsetDateTime::now_utc()),
            }
            .insert(&state.db)
            .await?;
            tell(&state, &calendar, user_id, session.user_id, level).await?;
        }
    }
    state
        .hub
        .publish(
            vec![user_id],
            RealtimeEnvelope::calendar_changed(calendar_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/calendars/{calendar_id}/shares/{user_id}`: take a share back, at once.
#[utoipa::path(
    delete,
    path = "/api/v1/calendars/{calendar_id}/shares/{user_id}",
    tag = "calendar",
    params(
        ("calendar_id" = Uuid, Path, description = "Calendar id"),
        ("user_id" = Uuid, Path, description = "The person")
    ),
    responses(
        (status = 204, description = "No longer shared"),
        (status = 404, description = "Not the caller's calendar")
    )
)]
pub async fn delete_share(
    State(state): State<AppState>,
    session: AuthSession,
    Path((calendar_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, CalendarError> {
    owned(&state.db, session.user_id, calendar_id).await?;
    calendar_shares::Entity::delete_by_id((calendar_id, user_id))
        .exec(&state.db)
        .await?;
    state
        .hub
        .publish(
            vec![user_id],
            RealtimeEnvelope::calendar_changed(calendar_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/calendars/{calendar_id}/share-candidates?q=`: the people the caller has a space in
/// common with, by name or address, twenty at most.
#[utoipa::path(
    get,
    path = "/api/v1/calendars/{calendar_id}/share-candidates",
    tag = "calendar",
    params(
        ("calendar_id" = Uuid, Path, description = "Calendar id"),
        ("q" = Option<String>, Query, description = "Part of a name or an address")
    ),
    responses(
        (status = 200, description = "People to share with", body = [CandidateDto]),
        (status = 404, description = "Not the caller's calendar")
    )
)]
pub async fn share_candidates(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Query(query): Query<CandidatesQuery>,
) -> Result<Json<Vec<CandidateDto>>, CalendarError> {
    owned(&state.db, session.user_id, calendar_id).await?;
    // The words are the pattern's content, never its syntax.
    let escaped = query
        .q
        .trim()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT DISTINCT u.id, u.display_name FROM users u \
               JOIN space_members b ON b.user_id = u.id \
               JOIN space_members a ON a.space_id = b.space_id AND a.user_id = $1 \
              WHERE u.id <> $1 AND u.status = 'active' AND NOT u.is_bot \
                AND (ruchoir_unaccent(u.display_name) ILIKE '%' || ruchoir_unaccent($2) || '%' \
                     OR u.email ILIKE '%' || $2 || '%') \
              ORDER BY u.display_name LIMIT 20",
            [session.user_id.into(), escaped.into()],
        ))
        .await?;
    let mut found = Vec::with_capacity(rows.len());
    for row in rows {
        found.push(CandidateDto {
            user_id: row.try_get("", "id")?,
            name: row.try_get("", "display_name")?,
        });
    }
    Ok(Json(found))
}

/// Tell `person` that `actor` opened `calendar` to them: in the app and by push, never by mail.
async fn tell(
    state: &AppState,
    calendar: &calendars::Model,
    person: Uuid,
    actor: Uuid,
    level: ShareLevel,
) -> Result<(), CalendarError> {
    let now = OffsetDateTime::now_utc();
    let payload = serde_json::to_value(SharedPayload {
        calendar_id: calendar.id,
        calendar_name: calendar.name.clone(),
        level: level.as_str().to_owned(),
    })
    .map_err(|_| CalendarError::Internal)?;
    let row = notifications::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(person),
        kind: Set("calendar_shared".to_owned()),
        conversation_id: Set(None),
        message_id: Set(None),
        event_id: Set(None),
        occurrence_start: Set(None),
        payload: Set(Some(payload)),
        actor_id: Set(Some(actor)),
        created_at: Set(now),
        read_at: Set(None),
        // Never mailed: the unread digest leaves it alone.
        email_handled_at: Set(Some(now)),
    }
    .insert(&state.db)
    .await?;
    crate::notify::push::dispatch(state, std::slice::from_ref(&row));
    for dto in hydrate(&state.db, vec![row]).await? {
        state
            .hub
            .publish(vec![person], RealtimeEnvelope::notification_created(&dto))
            .await;
    }
    Ok(())
}

/// Draw share notifications: who shared which calendar.
pub async fn hydrate<C: ConnectionTrait>(
    db: &C,
    rows: Vec<notifications::Model>,
) -> Result<Vec<NotificationDto>, CalendarError> {
    let names: HashMap<Uuid, String> =
        super::attendees::names(db, rows.iter().filter_map(|r| r.actor_id)).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let payload: SharedPayload = serde_json::from_value(row.payload.clone()?).ok()?;
            Some(NotificationDto {
                id: row.id,
                kind: row.kind.clone(),
                conversation_id: None,
                space_id: None,
                channel_name: None,
                space_name: String::new(),
                message_id: None,
                actor_id: row.actor_id,
                actor_name: row.actor_id.and_then(|a| names.get(&a).cloned()),
                preview: String::new(),
                created_at: instant_text(row.created_at),
                read: row.read_at.is_some(),
                event_id: None,
                recurrence_id: None,
                event_title: None,
                event_start: None,
                event_all_day: None,
                event_location: None,
                calendar_name: Some(payload.calendar_name),
                event_changes: None,
                event_my_status: None,
            })
        })
        .collect())
}

/// A share notification in words, for a push: who, and which calendar.
pub fn texts(locale: Locale, dto: &NotificationDto) -> (String, String) {
    let who = dto
        .actor_name
        .clone()
        .unwrap_or_else(|| crate::auth::mail_text::someone(locale).to_owned());
    let title = match locale {
        Locale::Fr => format!("{who} partage son agenda avec vous"),
        Locale::En => format!("{who} shared a calendar with you"),
        Locale::Es => format!("{who} ha compartido un calendario contigo"),
        Locale::De => format!("{who} hat einen Kalender mit Ihnen geteilt"),
        Locale::It => format!("{who} ha condiviso un calendario con te"),
        Locale::Pl => format!("{who} udostępnia Ci kalendarz"),
    };
    (title, dto.calendar_name.clone().unwrap_or_default())
}
