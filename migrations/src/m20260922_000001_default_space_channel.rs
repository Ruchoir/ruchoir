//! Give every space an explicit arrival channel.
//!
//! Before this migration, the application guessed an arrival channel from the oldest public
//! channel. That guess changed when data was imported and could not be administered. The column is
//! nullable only to let a newly created space insert its channel inside the same transaction; the
//! application fills it before committing. Existing spaces are backfilled deterministically.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // A prior application could have completed the DDL and then failed while backfilling.
        // PostgreSQL commits that `ALTER TABLE` before the following statement, so make retries
        // safe for those installations.
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE spaces ADD COLUMN IF NOT EXISTS default_channel_id uuid;",
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE spaces\n                 SET default_channel_id = (\n                   SELECT id\n                   FROM channels\n                   WHERE channels.space_id = spaces.id\n                     AND channels.type = 'public'\n                   ORDER BY channels.created_at, channels.id\n                   LIMIT 1\n                 )\n                 WHERE spaces.default_channel_id IS NULL\n                   AND EXISTS (\n                     SELECT 1\n                     FROM channels\n                     WHERE channels.space_id = spaces.id\n                       AND channels.type = 'public'\n                   );",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Spaces::Table)
                    .drop_column(Spaces::DefaultChannelId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Spaces {
    Table,
    DefaultChannelId,
}
