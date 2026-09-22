//! The `import_jobs` table: one attempt at bringing a workspace over from another product.
//!
//! The row is what an administrator watches while it runs and reads once it has stopped, so every
//! field here is meant to be shown: the counters drive the progress display, `manifest` holds what
//! the archive claimed about itself, and `error` is written for the person reading it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "import_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// `None` when the archive brings its own spaces and the job creates them.
    pub space_id: Option<Uuid>,
    /// Provenance only: the job outlives the account that started it.
    pub created_by: Option<Uuid>,
    /// One of `nextcloud`, `mattermost`, `slack`, `teams`.
    pub source: String,
    /// One of `pending`, `analyzing`, `ready`, `running`, `cancelling`, `cancelled`, `completed`,
    /// `failed`.
    pub status: String,
    /// JSON text: which conversations, whether history and attachments come along, and how
    /// accounts that match nothing are handled.
    pub options: String,
    pub archive_file_id: Option<Uuid>,
    pub manifest: Option<String>,
    pub channels_total: i32,
    pub channels_done: i32,
    pub messages_total: i32,
    pub messages_done: i32,
    pub files_total: i32,
    pub files_done: i32,
    pub accounts_total: i32,
    pub accounts_done: i32,
    /// Set only when `status` is `failed`, and phrased for the administrator.
    pub error: Option<String>,
    pub started_at: Option<TimeDateTimeWithTimeZone>,
    pub finished_at: Option<TimeDateTimeWithTimeZone>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
