//! The Drive files an event carries.
//!
//! A file is attached as it is, where it is: a file of a space's tree (never one attached to a
//! private conversation, whose audience is that conversation's), which the person attaching it can
//! read. The list belongs to the series and is replaced whole, like the attendees; only whoever may
//! change the event changes it.
//!
//! **An event gives access to its files**: whoever sees the event (through its calendar, an
//! invitation or its linked channel) may read them, and someone invited by address may download them
//! from their answer page. Taking a file off the event takes that access away; the file stays in the
//! Drive. Access through an event is read only: neither the file's settings nor its content.
//!
//! Files dropped from a device for an event go into the space's "Agenda" folder, created on first
//! use and found by its system key, as the attachments folder is.

use axum::extract::{Path, Query, State};
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use super::authz;
use super::error::CalendarError;
use super::links;
use crate::auth::extract::AuthSession;
use crate::entities::{calendar_event_files, calendar_events, files};
use crate::state::AppState;

/// The most files one event may carry.
pub const MAX_FILES: usize = 20;

/// The system key of a space's calendar folder.
const FOLDER_KEY: &str = "calendar_attachments";

/// A file an event carries.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EventFileDto {
    pub id: Uuid,
    pub name: String,
    pub size: i64,
}

#[derive(Debug, Deserialize)]
pub struct FolderQuery {
    /// For a personal calendar: the channel whose space receives the files.
    pub channel: Option<Uuid>,
}

/// Where files dropped for an event of a calendar go.
#[derive(Debug, Serialize, ToSchema)]
pub struct AttachmentFolderDto {
    pub space_id: Uuid,
    pub folder_id: Uuid,
}

/// An event's files, in the order they were added.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
) -> Result<Vec<EventFileDto>, CalendarError> {
    let links = calendar_event_files::Entity::find()
        .filter(calendar_event_files::Column::EventId.eq(event_id))
        .order_by_asc(calendar_event_files::Column::AddedAt)
        .all(db)
        .await?;
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let rows = files::Entity::find()
        .filter(files::Column::Id.is_in(links.iter().map(|l| l.file_id)))
        .filter(files::Column::DeletedAt.is_null())
        .all(db)
        .await?;
    Ok(links
        .iter()
        .filter_map(|l| rows.iter().find(|f| f.id == l.file_id))
        .map(|f| EventFileDto {
            id: f.id,
            name: f.name.clone(),
            size: f.size_bytes,
        })
        .collect())
}

/// Check a wanted list: at most [`MAX_FILES`], each a file (not a folder) of a space's tree that
/// `user` may read on their own (not only through an event). The files the event already carries
/// (`kept`) stay without being checked again: someone changing the list need not read every file
/// that someone else put there. Returns the ids, without repeats, in their order.
pub async fn check(
    db: &DatabaseConnection,
    user: Uuid,
    wanted: &[Uuid],
    kept: &[Uuid],
) -> Result<Vec<Uuid>, CalendarError> {
    let mut ids: Vec<Uuid> = Vec::new();
    for id in wanted {
        if !ids.contains(id) {
            ids.push(*id);
        }
    }
    if ids.len() > MAX_FILES {
        return Err(CalendarError::Invalid("An event carries at most 20 files."));
    }
    for id in ids.iter().filter(|id| !kept.contains(id)) {
        let access = crate::files::authz::ensure_readable(db, *id, user)
            .await
            .map_err(|_| CalendarError::Invalid("A file here cannot be attached."))?;
        // A file read only through another event is that event's to show, not one's own to pass on.
        if access.through_event
            || access.file.kind == "folder"
            || access.file.conversation_id.is_some()
        {
            return Err(CalendarError::Invalid("A file here cannot be attached."));
        }
    }
    Ok(ids)
}

/// Make an event's files the ones given (already checked).
pub async fn replace<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
    by: Uuid,
    ids: &[Uuid],
) -> Result<(), CalendarError> {
    calendar_event_files::Entity::delete_many()
        .filter(calendar_event_files::Column::EventId.eq(event_id))
        .filter(calendar_event_files::Column::FileId.is_not_in(ids.iter().copied()))
        .exec(db)
        .await?;
    let present: Vec<Uuid> = calendar_event_files::Entity::find()
        .filter(calendar_event_files::Column::EventId.eq(event_id))
        .all(db)
        .await?
        .into_iter()
        .map(|l| l.file_id)
        .collect();
    let now = OffsetDateTime::now_utc();
    for (n, id) in ids.iter().enumerate() {
        if present.contains(id) {
            continue;
        }
        calendar_event_files::ActiveModel {
            event_id: Set(event_id),
            file_id: Set(*id),
            added_by: Set(Some(by)),
            // Kept in the order given, a microsecond apart.
            added_at: Set(now + time::Duration::microseconds(n as i64)),
        }
        .insert(db)
        .await?;
    }
    Ok(())
}

/// The files an event carries, by id.
pub async fn carried<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
) -> Result<Vec<Uuid>, CalendarError> {
    Ok(calendar_event_files::Entity::find()
        .filter(calendar_event_files::Column::EventId.eq(event_id))
        .all(db)
        .await?
        .into_iter()
        .map(|l| l.file_id)
        .collect())
}

/// Copy an event's files to a new series cut from it.
pub async fn copy_to<C: ConnectionTrait>(
    db: &C,
    from: Uuid,
    to: Uuid,
) -> Result<(), CalendarError> {
    for link in calendar_event_files::Entity::find()
        .filter(calendar_event_files::Column::EventId.eq(from))
        .all(db)
        .await?
    {
        calendar_event_files::ActiveModel {
            event_id: Set(to),
            file_id: Set(link.file_id),
            added_by: Set(link.added_by),
            added_at: Set(link.added_at),
        }
        .insert(db)
        .await?;
    }
    Ok(())
}

/// Whether `user` may read `file_id` because an event they see carries it.
pub async fn grants(db: &DatabaseConnection, file_id: Uuid, user: Uuid) -> bool {
    let Ok(links) = calendar_event_files::Entity::find()
        .filter(calendar_event_files::Column::FileId.eq(file_id))
        .all(db)
        .await
    else {
        return false;
    };
    for link in links {
        let Ok(Some(event)) = calendar_events::Entity::find_by_id(link.event_id)
            .one(db)
            .await
        else {
            continue;
        };
        if matches!(links::reach(db, user, &event).await, Ok(Some(_))) {
            return true;
        }
    }
    false
}

/// Whether an event carries a file (for its public answer page).
pub async fn carries<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
    file_id: Uuid,
) -> Result<bool, CalendarError> {
    Ok(
        calendar_event_files::Entity::find_by_id((event_id, file_id))
            .one(db)
            .await?
            .is_some(),
    )
}

/// A space's "Agenda" folder, created on first use.
async fn folder_of(
    db: &DatabaseConnection,
    space_id: Uuid,
    owner: Uuid,
) -> Result<Uuid, CalendarError> {
    let find = || {
        files::Entity::find()
            .filter(files::Column::SpaceId.eq(space_id))
            .filter(files::Column::SystemKey.eq(FOLDER_KEY))
            .filter(files::Column::DeletedAt.is_null())
    };
    if let Some(existing) = find().one(db).await? {
        return Ok(existing.id);
    }
    let now = OffsetDateTime::now_utc();
    let created = files::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(space_id),
        owner_id: Set(Some(owner)),
        // A display name, in the product's language like the attachments folder's; the system key
        // is what finds it.
        name: Set("Agenda".to_owned()),
        kind: Set("folder".to_owned()),
        system_key: Set(Some(FOLDER_KEY.to_owned())),
        size_bytes: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await;
    match created {
        Ok(folder) => Ok(folder.id),
        // Another first upload won the race: read its folder back.
        Err(_) => find()
            .one(db)
            .await?
            .map(|f| f.id)
            .ok_or(CalendarError::Internal),
    }
}

/// `GET /api/v1/calendars/{calendar_id}/attachment-folder?channel=`: where files dropped for an
/// event of this calendar go: its space's "Agenda" folder, or, for a personal calendar, that of the
/// linked channel's space.
#[utoipa::path(
    get,
    path = "/api/v1/calendars/{calendar_id}/attachment-folder",
    tag = "calendar",
    params(
        ("calendar_id" = Uuid, Path, description = "Calendar id"),
        ("channel" = Option<Uuid>, Query, description = "For a personal calendar: the linked channel")
    ),
    responses(
        (status = 200, description = "The folder", body = AttachmentFolderDto),
        (status = 403, description = "May not write in this calendar"),
        (status = 422, description = "A personal calendar without a channel")
    )
)]
pub async fn attachment_folder(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Query(query): Query<FolderQuery>,
) -> Result<Json<AttachmentFolderDto>, CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    let space_id = match (access.calendar.space_id, query.channel) {
        (Some(space), _) => space,
        (None, Some(channel)) => {
            if !links::reads(&state.db, channel, session.user_id).await {
                return Err(CalendarError::Forbidden);
            }
            crate::entities::channels::Entity::find_by_id(channel)
                .one(&state.db)
                .await?
                .ok_or(CalendarError::NotFound)?
                .space_id
        }
        (None, None) => {
            return Err(CalendarError::Invalid(
                "A personal event keeps its files in the space of its channel.",
            ))
        }
    };
    crate::files::authz::ensure_space_files_member(&state.db, space_id, session.user_id)
        .await
        .map_err(|_| CalendarError::Forbidden)?;
    Ok(Json(AttachmentFolderDto {
        space_id,
        folder_id: folder_of(&state.db, space_id, session.user_id).await?,
    }))
}
