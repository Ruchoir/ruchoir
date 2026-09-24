//! The `dm_participants` table: who takes part in a direct-message conversation.
//!
//! Composite primary key (`dm_id`, `user_id`).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "dm_participants")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub dm_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    /// One of `default` (inherit from the space), `all` (every message), `mentions`, `none`
    /// (enforced by a CHECK constraint).
    pub notification_level: String,
    pub muted: bool,
    /// Per-participant "hide this conversation" flag.
    pub hidden: bool,
    pub added_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
