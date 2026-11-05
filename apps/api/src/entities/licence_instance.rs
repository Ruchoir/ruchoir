//! The `licence_instance` table: one row, what an edition with online licences keeps about the
//! instance itself (ADR 0010, amendment). The community build never writes it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "licence_instance")]
pub struct Model {
    /// Always 1.
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i16,
    /// Drawn at random once, sent with every check-in.
    pub instance_id: Uuid,
    /// The highest time seen (clock and statuses): a clock further back than a day is refused.
    pub highest_seen: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
