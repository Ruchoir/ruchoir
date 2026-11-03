//! The `user_preferences` table: per-user client preferences, so they follow a user across devices.
//!
//! - `notifications`: the notification settings (`crate::notify::prefs`).
//! - `font`, `emoji_animated` and `ui_state`: the account preferences (`crate::preferences`), the
//!   first two in their typed columns, every other key of its closed list as JSON in `ui_state`.
//! - `theme` and `text_size` stay empty by decision (2026-11-03): the theme and the text size are
//!   each device's own. `emoji_pack` is unused too.
//!
//! Stored as text rather than jsonb because the `with-json` SeaORM feature is not enabled; never
//! secret.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "user_preferences")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: Uuid,
    pub theme: Option<String>,
    pub font: Option<String>,
    pub text_size: Option<String>,
    pub emoji_pack: Option<String>,
    pub emoji_animated: Option<bool>,
    /// JSON blob of notification preferences (schema firmed up later).
    pub notifications: Option<String>,
    /// JSON blob of miscellaneous UI state (shortcuts, onboarding checklist).
    pub ui_state: Option<String>,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
