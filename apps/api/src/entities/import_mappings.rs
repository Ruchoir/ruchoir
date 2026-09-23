//! The `import_mappings` table: which identifier in the source became which row here.
//!
//! One row per imported entity, written in the same transaction as the entity itself. That is what
//! makes an import replayable: a second run finds the mapping and skips, so nothing is imported
//! twice and a run that died halfway resumes at the first unmapped entity.
//!
//! `space_id` is `None` for what belongs to the instance rather than to a space: an account and a
//! space itself. An account is one person on this instance, not one person per space, and a space
//! does not live inside a space. A conversation, a message and a file all carry one.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "import_mappings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub job_id: Uuid,
    pub space_id: Option<Uuid>,
    /// One of `nextcloud`, `mattermost`, `slack`, `teams`.
    pub source: String,
    /// One of `space`, `user`, `channel`, `message`, `file`.
    pub kind: String,
    /// The identifier as the source spells it, untouched.
    pub external_ref: String,
    pub internal_id: Uuid,
    /// Whose namespace this correspondence lives in: `None` for an import run by an administrator
    /// of the instance, the importer otherwise. Two people importing from the same product never
    /// recognise each other's rows.
    pub owner_id: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
