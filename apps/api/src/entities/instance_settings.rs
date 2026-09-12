//! The `instance_settings` table: one row, for what an administrator decides server-wide.
//!
//! Not a space setting (those belong to a space) and not a user preference (those belong to a
//! person). The primary key is a boolean constrained to `true`, so the table holds exactly one row
//! and no reader ever has to pick between two answers.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "instance_settings")]
pub struct Model {
    /// Always `true`: the key that makes this table single-row.
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: bool,
    /// Whether the interface tells everyone who administers the instance.
    ///
    /// On by default, because recovering an account on an instance with no mail relay ends with
    /// "ask an administrator", which needs them to be identifiable. Turned off, the badge is shown
    /// only to administrators themselves, who still need to find each other.
    pub show_instance_admins: bool,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
