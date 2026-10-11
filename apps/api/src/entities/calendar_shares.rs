//! The `calendar_shares` table: a personal calendar shared with someone, at a level.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_shares")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub calendar_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    /// `freebusy`, `read` or `write`.
    pub level: String,
    pub created_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
