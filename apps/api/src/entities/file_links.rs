//! The `file_links` table: public links to a file (see the `m20261003_000002_file_links` migration).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "file_links")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub file_id: Uuid,
    pub space_id: Uuid,
    /// The key the link's address carries (48 hex characters).
    pub token: String,
    pub created_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    /// When the link stops working (`None`: never).
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    /// The password it asks for, as an argon2id PHC string (`None`: none).
    pub password_hash: Option<String>,
    /// How many times the file was downloaded through it.
    pub download_count: i32,
    /// When it was revoked (`None`: live).
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
