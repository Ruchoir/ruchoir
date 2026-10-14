//! The `push_devices` table: one row per phone that allowed notifications (ADR 0006).
//!
//! `token` is what Apple or Google handed the app for this device, unique; `platform` says which of
//! the two. The instance never sends to the vendor itself: it hands the token to the publisher's
//! relay (`crate::notify::phone`). Rows go with the account.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "push_devices")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    /// `ios` or `android`.
    pub platform: String,
    pub token: String,
    pub created_at: TimeDateTimeWithTimeZone,
    /// Refreshed at every start of the app; a phone unseen for sixty days is forgotten.
    pub last_seen_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
