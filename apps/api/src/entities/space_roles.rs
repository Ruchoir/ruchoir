//! The `space_roles` table: a space's roles and the permission names each grants.
//!
//! Three are system roles every space holds (`system_key`): `administrator`, and the base roles
//! `members` and `guests`, which nobody is assigned (the standing implies them).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_roles")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    /// `administrator`, `members` or `guests` for a system role, `None` for a space's own.
    pub system_key: Option<String>,
    /// Unique in the space, case-insensitively (`citext`).
    pub name: String,
    /// One of the palette's pastels, or none.
    pub colour: Option<String>,
    /// Strongest first: a higher position outranks a lower one.
    pub position: i32,
    /// Permission names (`apps/api/src/permissions/catalogue.rs`); unknown ones are ignored.
    pub permissions: Vec<String>,
    pub created_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
