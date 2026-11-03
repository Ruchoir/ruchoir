//! The `space_licences` table: the licence installed in a space, at most one (ADR 0010).
//!
//! The community build never reads it beyond the tests; an edition built on this crate verifies
//! `licence` (the signed document) and keeps the rest as what it read from it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_licences")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub space_id: Uuid,
    /// The signed document, as installed.
    pub licence: String,
    pub licence_id: Uuid,
    pub organisation: String,
    /// Owners and members it covers; guests take no seat.
    pub seats: i32,
    pub valid_until: TimeDateTimeWithTimeZone,
    pub installed_by: Option<Uuid>,
    pub installed_at: TimeDateTimeWithTimeZone,
    /// The last expiry reminder sent: 30, 7 or 1 days before `valid_until`.
    pub reminded_days: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
