//! The `space_members` table: a user's membership of a space, with a role.
//!
//! Composite primary key (`space_id`, `user_id`): a user belongs to a space at most once.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_members")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub space_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    /// One of `owner`, `admin`, `member`, `guest` (enforced by a CHECK constraint).
    pub role: String,
    pub invited_by: Option<Uuid>,
    pub joined_at: TimeDateTimeWithTimeZone,
    /// `owner`, `member` or `guest`; derived from `role` by a trigger, never written.
    pub standing: String,
    /// When a guest's access ends; `None` for no end (and always for anyone who is not a guest).
    /// From that instant the person is no longer in the space (see `permissions::membership`).
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    /// When the last end-of-access reminder was sent.
    pub expiry_notice_sent_at: Option<TimeDateTimeWithTimeZone>,
    /// How far the reminders went: `7`, `1`, then `0` (ended and announced); `None` before any.
    pub expiry_stage: Option<i16>,
    /// The import that brought this person, as `<source>:<job id>`; `None` when they came by hand.
    pub imported_from: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
