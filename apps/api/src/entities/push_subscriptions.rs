//! The `push_subscriptions` table: one row per browser that asked for Web Push.
//!
//! `endpoint` is the URL the browser's push service handed out for this subscription, and it is
//! unique: the same browser subscribing again (or another account signing in on it) updates the row
//! rather than adding a second one, so nobody is notified twice or on someone else's behalf.
//! `p256dh` and `auth` are the subscription's encryption keys. Pushes carry no payload today, so
//! they are kept for completeness rather than used. Rows go with the account.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "push_subscriptions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    /// The browser's own description of itself, to tell devices apart when debugging.
    pub user_agent: Option<String>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub last_success_at: Option<TimeDateTimeWithTimeZone>,
    /// Consecutive failed deliveries. Reset by a success; the row is dropped past a threshold.
    pub failures: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
