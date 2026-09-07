//! The files feature: a per-space folder tree, upload with versioning, download and inline preview,
//! server-generated image thumbnails, file shares, and files attached to messages. Bytes live in an
//! S3-compatible object store behind the `storage` module; this module owns the metadata, the
//! authorization choke point, and the byte proxying (the browser never talks to the store directly).
//!
//! [`images`] is the exception to all of that: avatars and space icons are not files, have their own
//! keys and their own audiences, and are kept apart on purpose.

mod authz;
pub(crate) mod download;
pub(crate) mod dto;
mod error;
pub(crate) mod images;
mod mime;
mod routes;
pub(crate) mod shares;
mod thumbnail;
pub(crate) mod tree;
pub(crate) mod uploads;

pub use dto::AttachmentDto;
pub use images::{avatar_url, icon_url};
pub use routes::router;

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use uuid::Uuid;

use crate::entities::{file_versions, files, message_attachments, users};
use dto::FileDto;
use error::FileError;

/// Turn file rows into DTOs, batch-loading their current versions and owner names in a fixed number
/// of queries (a page costs a handful of queries rather than one per file).
pub(crate) async fn hydrate_files(
    db: &DatabaseConnection,
    rows: Vec<files::Model>,
) -> Result<Vec<FileDto>, FileError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let version_ids: Vec<Uuid> = rows.iter().filter_map(|f| f.current_version_id).collect();
    let versions = load_versions(db, version_ids).await?;

    let owner_ids: Vec<Uuid> = rows.iter().filter_map(|f| f.owner_id).collect();
    let names = load_names(db, owner_ids).await?;

    Ok(rows
        .into_iter()
        .map(|file| {
            let version = file.current_version_id.and_then(|id| versions.get(&id));
            let owner_name = file.owner_id.and_then(|id| names.get(&id).cloned());
            FileDto::from_models(&file, version, owner_name)
        })
        .collect())
}

/// The attachments of a set of messages, grouped by message id, in attachment order. Used by the
/// messaging hydrate so a message page carries its attachments without an extra query per message.
pub(crate) async fn attachments_for_messages(
    db: &DatabaseConnection,
    message_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<AttachmentDto>>, FileError> {
    let mut grouped: HashMap<Uuid, Vec<AttachmentDto>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(grouped);
    }

    let links = message_attachments::Entity::find()
        .filter(message_attachments::Column::MessageId.is_in(message_ids.to_vec()))
        .order_by_asc(message_attachments::Column::Position)
        .all(db)
        .await?;
    if links.is_empty() {
        return Ok(grouped);
    }

    let file_ids: Vec<Uuid> = links.iter().map(|l| l.file_id).collect();
    let files: HashMap<Uuid, files::Model> = files::Entity::find()
        .filter(files::Column::Id.is_in(file_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|f| (f.id, f))
        .collect();

    // The attached version is the pinned one when set, else the file's current version.
    let mut version_ids: Vec<Uuid> = Vec::new();
    for link in &links {
        if let Some(vid) = link.file_version_id {
            version_ids.push(vid);
        } else if let Some(file) = files.get(&link.file_id) {
            if let Some(vid) = file.current_version_id {
                version_ids.push(vid);
            }
        }
    }
    let versions = load_versions(db, version_ids).await?;

    for link in links {
        let Some(file) = files.get(&link.file_id) else {
            continue;
        };
        let version_id = link.file_version_id.or(file.current_version_id);
        let version = version_id.and_then(|id| versions.get(&id));
        grouped
            .entry(link.message_id)
            .or_default()
            .push(AttachmentDto::from_models(
                file,
                version,
                link.alt_text.clone(),
            ));
    }

    Ok(grouped)
}

/// Batch-load file versions into a map keyed by version id.
async fn load_versions(
    db: &DatabaseConnection,
    ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, file_versions::Model>, FileError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(file_versions::Entity::find()
        .filter(file_versions::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|v| (v.id, v))
        .collect())
}

/// Batch-load display names into a map keyed by user id.
async fn load_names(
    db: &DatabaseConnection,
    ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, String>, FileError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect())
}
