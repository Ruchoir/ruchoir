//! The `spaces` table: one row per workspace (the top-level tenant boundary).
//!
//! `slug` is a case-insensitive `citext` column, surfaced here as a `String`. `created_by` is
//! nullable so a space outlives the account that created it. Relations are added when query code
//! needs them, matching the auth entities.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "spaces")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_by: Option<Uuid>,
    /// Object-store key of the uploaded icon, or `None` to fall back to the generated mark. Never a
    /// remote URL.
    pub icon_key: Option<String>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
