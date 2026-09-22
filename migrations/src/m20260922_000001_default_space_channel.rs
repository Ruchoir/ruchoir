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
        manager
            .alter_table(
                Table::alter()
                    .table(Spaces::Table)
                    .add_column(ColumnDef::new(Spaces::DefaultChannelId).uuid().null())
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE spaces\n                 SET default_channel_id = selected.id\n                 FROM LATERAL (\n                   SELECT id\n                   FROM channels\n                   WHERE channels.space_id = spaces.id\n                     AND channels.channel_type = 'public'\n                   ORDER BY channels.created_at, channels.id\n                   LIMIT 1\n                 ) AS selected\n                 WHERE spaces.default_channel_id IS NULL;",
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
