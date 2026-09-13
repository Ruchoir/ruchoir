//! The `instance_events` table: what happened to the instance itself.
//!
//! Two kinds so far. `backup_taken` is written by the backup script when it finishes, because the
//! API cannot see the files a shell script produced; the import reads it to refuse a replacement
//! without a recent backup. `instance_replaced` is written by that replacement, and is the only
//! account of it that survives, since everything else it describes has been destroyed.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "instance_events")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// One of `backup_taken`, `instance_replaced` (enforced by a CHECK constraint).
    pub kind: String,
    pub occurred_at: TimeDateTimeWithTimeZone,
    /// `None` for a backup taken by a timer, and for a replacement whose author has since gone.
    pub actor_id: Option<Uuid>,
    /// JSON text, written for a person reading it months later.
    pub detail: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
