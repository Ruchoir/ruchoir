//! Every slug a space has ever answered to.
//!
//! A slug lives in bookmarks and in links people have already sent each other, so renaming a space
//! must not break them. Keeping only the current slug forces a choice between a stale address and a
//! dead one; keeping the history lets the new name take effect while the old address still arrives.
//!
//! The table holds the current slug too, not only retired ones. That is what makes it the single
//! place uniqueness is decided: a new space can no longer be minted on a slug some other space used
//! to answer to, which would quietly hijack every link ever shared for it. Rows are never deleted,
//! for the same reason.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SpaceSlugs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SpaceSlugs::Slug)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SpaceSlugs::SpaceId).uuid().not_null())
                    .col(
                        ColumnDef::new(SpaceSlugs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_space_slugs_space")
                            .from(SpaceSlugs::Table, SpaceSlugs::SpaceId)
                            .to(Spaces::Table, Spaces::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Resolving an address is "which space answers to this slug", and the primary key covers it.
        // This one covers the other direction, listing a space's addresses.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_space_slugs_space")
                    .table(SpaceSlugs::Table)
                    .col(SpaceSlugs::SpaceId)
                    .to_owned(),
            )
            .await?;

        // Adopt the slugs that already exist, so uniqueness is decided here from the first rename
        // rather than from the first space created after this migration.
        manager
            .get_connection()
            .execute_unprepared(
                "INSERT INTO space_slugs (slug, space_id) \
                 SELECT slug, id FROM spaces ON CONFLICT (slug) DO NOTHING",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SpaceSlugs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SpaceSlugs {
    Table,
    Slug,
    SpaceId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Spaces {
    Table,
    Id,
}
