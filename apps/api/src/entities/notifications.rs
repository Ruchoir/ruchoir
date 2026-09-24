//! The `notifications` table: a per-user in-app inbox.
//!
//! One row per delivered notification. `kind` is `mention`, `broadcast`, `reply` or `dm` (enforced by
//! a CHECK constraint). `read_at` NULL means unread. Rows cascade away with the source message or the
//! recipient; `actor_id` is nulled if the author's account is removed.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "notifications")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    /// One of `mention`, `broadcast`, `reply`, `dm`.
    pub kind: String,
    pub conversation_id: Uuid,
    pub message_id: Uuid,
    pub actor_id: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub read_at: Option<TimeDateTimeWithTimeZone>,
    /// When the email fallback decided about this row, whether it sent an email or not. NULL means
    /// it is still waiting for its turn (see `crate::notify::email`).
    pub email_handled_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
