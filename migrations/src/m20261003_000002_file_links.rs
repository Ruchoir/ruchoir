//! Public links: a file handed to someone outside the space, by an address that carries its key.
//!
//! The token is kept as it is, not hashed: the people who manage the file copy the link again later,
//! as in Nextcloud, and the token is random enough (24 bytes) to be the only thing that matters. A
//! link may end (`expires_at`), may ask for a password (`password_hash`, argon2id), and is revoked
//! rather than deleted, so a dead link says why. It dies with its file (the foreign key cascades
//! when a row is ever removed, and the API refuses a link whose file is in the trash or erased).

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE file_links ( \
                     id uuid PRIMARY KEY, \
                     file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE, \
                     space_id uuid NOT NULL, \
                     token text NOT NULL UNIQUE, \
                     created_by uuid, \
                     created_at timestamptz NOT NULL, \
                     expires_at timestamptz, \
                     password_hash text, \
                     download_count integer NOT NULL DEFAULT 0, \
                     revoked_at timestamptz \
                 ); \
                 CREATE INDEX idx_file_links_file ON file_links (file_id);",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS file_links;")
            .await?;
        Ok(())
    }
}
