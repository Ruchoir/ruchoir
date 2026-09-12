//! Response and request shapes for the files surface.
//!
//! Kept close to the web data seam (`apps/web/lib/data/types.ts`: `SpaceFile`, `MessageAttachment`)
//! so wiring the client later is mechanical, but ids are real UUIDs and timestamps are RFC 3339
//! strings, and raw byte sizes are returned (the client formats them for display).

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::entities::{file_versions, files};

/// A file or folder entry, with the current version's metadata folded in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileDto {
    pub id: Uuid,
    pub space_id: Uuid,
    pub name: String,
    /// One of `file`, `file-text`, `file-spreadsheet`, `image`, `folder`.
    pub kind: String,
    pub is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<Uuid>,
    pub size_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_no: Option<i32>,
    /// Whether a thumbnail exists for this file's current version.
    pub has_thumbnail: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<i32>,
    /// Whether the file was migrated from another tool.
    pub imported: bool,
    /// The source connector a migrated file came from (e.g. "nextcloud"); absent for native files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl FileDto {
    /// Build a DTO from a file row plus its (optional) current version and resolved owner name.
    pub fn from_models(
        file: &files::Model,
        version: Option<&file_versions::Model>,
        owner_name: Option<String>,
    ) -> Self {
        FileDto {
            id: file.id,
            space_id: file.space_id,
            name: file.name.clone(),
            kind: file.kind.clone(),
            is_folder: file.kind == "folder",
            parent_folder_id: file.parent_folder_id,
            size_bytes: file.size_bytes,
            owner_id: file.owner_id,
            owner_name,
            mime_type: version.map(|v| v.mime_type.clone()),
            version_id: version.map(|v| v.id),
            version_no: version.map(|v| v.version_no),
            has_thumbnail: version.map(|v| v.thumbnail_key.is_some()).unwrap_or(false),
            image_width: version.and_then(|v| v.image_width),
            image_height: version.and_then(|v| v.image_height),
            imported: file.imported_source.is_some(),
            imported_source: file.imported_source.clone(),
            created_at: rfc3339(file.created_at),
            updated_at: rfc3339(file.updated_at),
        }
    }
}

/// One step of a folder breadcrumb, from the space root down to the current folder.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Breadcrumb {
    pub id: Uuid,
    pub name: String,
}

/// The contents of a folder (or the space root when `folder_id` is `None`).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FolderListing {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<Uuid>,
    pub breadcrumb: Vec<Breadcrumb>,
    pub entries: Vec<FileDto>,
}

/// A file attached to a message.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AttachmentDto {
    pub file_id: Uuid,
    pub name: String,
    pub kind: String,
    pub size_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<Uuid>,
    pub has_thumbnail: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
    /// The file has since been removed from the space.
    ///
    /// The attachment is still reported, because the message said something by carrying it and a
    /// silent disappearance reads as a bug. What changes is that the client must not offer to open
    /// bytes that are gone: every link to them answers 404, which is what a deleted attachment
    /// looked like before this field existed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

impl AttachmentDto {
    /// Build a DTO from the attached file plus the specific version and optional alt text.
    pub fn from_models(
        file: &files::Model,
        version: Option<&file_versions::Model>,
        alt_text: Option<String>,
    ) -> Self {
        AttachmentDto {
            file_id: file.id,
            name: file.name.clone(),
            kind: file.kind.clone(),
            size_bytes: version.map(|v| v.size_bytes).unwrap_or(file.size_bytes),
            mime_type: version.map(|v| v.mime_type.clone()),
            version_id: version.map(|v| v.id),
            has_thumbnail: version.map(|v| v.thumbnail_key.is_some()).unwrap_or(false),
            image_width: version.and_then(|v| v.image_width),
            image_height: version.and_then(|v| v.image_height),
            alt_text,
            deleted: file.deleted_at.is_some(),
        }
    }
}

/// A file share targeting a user or a channel.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ShareDto {
    pub id: Uuid,
    pub file_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_channel_id: Option<Uuid>,
    /// `view` or `edit`.
    pub permission: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

// --- Request bodies ---

/// Create a folder inside a space (optionally under a parent folder).
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFolderRequest {
    pub name: String,
    #[serde(default)]
    pub parent_folder_id: Option<Uuid>,
}

/// Rename and/or move a file or folder. Renaming sets `name`; moving sets `parent_folder_id`, or
/// `move_to_root` to place the entry at the space root (distinct from "leave the parent unchanged").
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateFileRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub parent_folder_id: Option<Uuid>,
    #[serde(default)]
    pub move_to_root: bool,
}

/// Create a share for a file. Exactly one target (user or channel) must be set.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateShareRequest {
    #[serde(default)]
    pub target_user_id: Option<Uuid>,
    #[serde(default)]
    pub target_channel_id: Option<Uuid>,
    /// `view` (default) or `edit`.
    #[serde(default = "default_permission")]
    pub permission: String,
}

fn default_permission() -> String {
    "view".to_owned()
}

/// Format an `OffsetDateTime` as RFC 3339, falling back to an empty string on the impossible error.
pub fn rfc3339(ts: OffsetDateTime) -> String {
    ts.format(&Rfc3339).unwrap_or_default()
}
