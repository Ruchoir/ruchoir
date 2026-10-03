//! Favourites: the files and folders a person keeps at hand, theirs alone.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE file_stars ( \
                     user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
                     file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE, \
                     created_at timestamptz NOT NULL, \
                     PRIMARY KEY (user_id, file_id) \
                 );",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS file_stars;")
            .await?;
        Ok(())
    }
}
