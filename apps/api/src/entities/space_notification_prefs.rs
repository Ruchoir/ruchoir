//! The `space_notification_prefs` table: how much one space notifies one person.
//!
//! Composite primary key (`user_id`, `space_id`). No row means the person's own default; a row holds
//! `all` (every message), `mentions` or `none`, and applies to every conversation of the space whose
//! own level is `default`.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_notification_prefs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub space_id: Uuid,
    pub level: String,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
