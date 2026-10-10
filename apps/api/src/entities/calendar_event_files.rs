//! The `calendar_event_files` table: which Drive files an event (its whole series) carries. The file
//! stays where it is in the Drive; whoever sees the event may read it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_event_files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub event_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub file_id: Uuid,
    pub added_by: Option<Uuid>,
    pub added_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
