//! The `space_groups` table: named sets of a space's members that carry roles.

#![allow(dead_code)]

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_groups")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    /// `manual` (the space's own) or `directory` (kept in step with a directory).
    pub source: String,
    pub external_id: Option<String>,
    pub created_by: Option<Uuid>,
    /// The import that created this group, as `<source>:<job id>`; `None` for a hand-made one.
    pub imported_from: Option<String>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
