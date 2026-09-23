//! The `channels` table: the "channel" flavour of a conversation.
//!
//! `id` is both the primary key and a foreign key onto the parent conversation (shared-primary-key
//! inheritance). `channel_type` maps to the SQL column `type` (a Rust keyword). `imported_source`
//! and `external_ref` carry provenance stamped by the importers.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "channels")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    pub name: String,
    /// One of `public`, `private`, `archived` (enforced by a CHECK constraint).
    #[sea_orm(column_name = "type")]
    pub channel_type: String,
    pub topic: Option<String>,
    pub created_by: Option<Uuid>,
    pub archived_at: Option<TimeDateTimeWithTimeZone>,
    pub imported_source: Option<String>,
    pub external_ref: Option<String>,
    /// The space's own order for its channels, set by its administrators. `None` until the channel
    /// has been placed: it then comes after the placed ones, by creation.
    pub position: Option<i32>,
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
