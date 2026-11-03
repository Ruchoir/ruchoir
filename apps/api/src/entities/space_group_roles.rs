//! The `space_group_roles` table: the roles a group carries, for each of its members.

#![allow(dead_code)]

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_group_roles")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub group_id: Uuid,
    pub space_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub role_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
