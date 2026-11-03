//! The `space_role_assignments` table: who holds which role. Leaving a space drops the rows.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_role_assignments")]
pub struct Model {
    pub space_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub role_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
