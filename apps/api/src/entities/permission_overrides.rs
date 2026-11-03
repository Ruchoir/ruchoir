//! The `permission_overrides` table: a rule on a channel, a file (or folder) or a calendar, for a
//! role or a person, allowing and denying permission names.
//!
//! Exactly one resource and one target per row (CHECK constraints), at most one rule per resource
//! and target (unique indexes), and every foreign key cascades, so no rule outlives what it is
//! about.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "permission_overrides")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    pub channel_id: Option<Uuid>,
    pub file_id: Option<Uuid>,
    pub calendar_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub created_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
