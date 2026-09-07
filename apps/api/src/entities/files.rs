//! The `files` table: files and folders (a folder is a row with `kind = 'folder'`).
//!
//! The tree is expressed through the self-referential `parent_folder_id`. `current_version_id` is
//! an app-maintained pointer with no database foreign key (it would form a cycle with
//! `file_versions.file_id`). Soft-deleted via `deleted_at`.
//!
//! `conversation_id` gives a file an audience narrower than its space: set, the file was attached to
//! a message in a private conversation, stays out of the space tree, and is readable only by that
//! conversation's participants. `system_key` marks a folder the product maintains (the one public
//! attachments land in), so it is found by that marker and not by a name a user may change.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    pub owner_id: Option<Uuid>,
    pub name: String,
    /// One of `file`, `file-text`, `file-spreadsheet`, `image`, `folder` (CHECK-constrained).
    pub kind: String,
    pub parent_folder_id: Option<Uuid>,
    /// Set when the file belongs to one conversation rather than to the whole space.
    pub conversation_id: Option<Uuid>,
    /// Marker for a product-maintained folder (currently only `attachments`), unique per space.
    pub system_key: Option<String>,
    pub current_version_id: Option<Uuid>,
    pub size_bytes: i64,
    pub imported_source: Option<String>,
    pub external_ref: Option<String>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
