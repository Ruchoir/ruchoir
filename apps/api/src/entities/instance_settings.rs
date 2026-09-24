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
    /// Whether the instance sends Web Push at all.
    ///
    /// On by default, and still opt-in per person and per browser. It exists because a push goes
    /// through the push service of the reader's browser vendor, which the instance does not choose
    /// (see ADR 0001): an administrator who will not accept that turns it off here, and the
    /// interface stops offering it.
    pub web_push_enabled: bool,
    /// The public half of the VAPID key pair (RFC 8292), as the browser's `applicationServerKey`
    /// expects it: the uncompressed P-256 point, base64url without padding. Generated on first use.
    pub vapid_public_key: Option<String>,
    /// The private half, a 32-byte P-256 scalar encrypted with the instance's secret key.
    pub vapid_private_key: Option<Vec<u8>>,
    /// The AES-GCM nonce of `vapid_private_key`.
    pub vapid_private_nonce: Option<Vec<u8>>,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
