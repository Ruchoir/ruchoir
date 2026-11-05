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
    /// The next document, waiting to take over at its start (a renewal).
    pub next_licence: Option<String>,
    /// The latest status the edition accepted for an online licence, as received.
    pub status_token: Option<String>,
    pub status_token_issued_at: Option<TimeDateTimeWithTimeZone>,
    /// The last check-in that got an answer, and the last one tried.
    pub last_check_in_at: Option<TimeDateTimeWithTimeZone>,
    pub last_attempt_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
