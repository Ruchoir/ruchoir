//! The `channel_members` table: channel access plus per-user notification preferences.
//!
//! Composite primary key (`channel_id`, `user_id`).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "channel_members")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub channel_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    /// One of `owner`, `admin`, `member` (enforced by a CHECK constraint).
    pub role: String,
    /// One of `default` (inherit from the space), `all` (every message), `mentions`, `none`
    /// (enforced by a CHECK constraint).
    pub notification_level: String,
    pub muted: bool,
    /// Per-user sidebar favourite (the mock's `fav` flag).
    pub favorite: bool,
    pub joined_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
