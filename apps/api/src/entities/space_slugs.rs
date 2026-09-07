//! The `space_slugs` table: every slug a space has ever answered to, its current one included.
//!
//! Renaming a space moves its slug, and the address people already hold must keep arriving, so the
//! retired ones stay here and resolve to the same space. Holding the current slug too makes this the
//! single place uniqueness is decided: no new space can be minted on a slug another one used to
//! answer to, which would quietly hijack every link ever shared for it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_slugs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub slug: String,
    pub space_id: Uuid,
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
