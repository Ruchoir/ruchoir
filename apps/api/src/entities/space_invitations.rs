//! The `space_invitations` table: an outstanding invitation into a space.
//!
//! `token_hash` is the SHA-256 digest of the invitation token, hex encoded; the token itself is
//! never stored, so this row cannot be turned back into a working link. `email` set means the
//! invitation is addressed to one person (and the accepting account's address must match); `None`
//! means it is a shareable link. `max_uses` of `None` is unlimited.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "space_invitations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Uuid,
    #[sea_orm(unique)]
    pub token_hash: String,
    /// Case-insensitive `citext` in PostgreSQL; `None` for a shareable link.
    pub email: Option<String>,
    /// One of `admin`, `member`, `guest` (enforced by a CHECK constraint). Never `owner`.
    pub role: String,
    pub created_by: Option<Uuid>,
    /// `None` means unlimited.
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
