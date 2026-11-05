//! The `licence_kill_notices` table: every notice received that a signing certificate must never
//! be trusted again, kept forever (ADR 0010, amendment). The community build never writes it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "licence_kill_notices")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub serial: Uuid,
    /// The signed notice, as received.
    pub notice: String,
    pub received_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
