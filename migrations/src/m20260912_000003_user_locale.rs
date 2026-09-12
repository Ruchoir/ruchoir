//! The language a person reads Ruchoir in.
//!
//! The interface chooses its own language in the browser, but the server writes too: address
//! confirmations, password resets and invitations. Without this column those go out in one language
//! whatever the recipient reads, which is the half of the product a browser preference cannot reach.
//!
//! Nullable, and null is not French: it means nobody has chosen, so the client keeps following the
//! browser and the server falls back to the source language.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(ColumnDef::new(Users::Locale).text().null())
                    .to_owned(),
            )
            .await?;
        // The six the product speaks. A tag outside them would be stored happily and then read as
        // French forever, which is a bug that looks like a preference.
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE users ADD CONSTRAINT ck_users_locale \
                 CHECK (locale IS NULL OR locale IN ('fr', 'en', 'es', 'de', 'it', 'pl'))",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_locale")
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .drop_column(Users::Locale)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

/// Local reference to the `users` table (owned by the auth migration) plus the new column.
#[derive(DeriveIden)]
enum Users {
    Table,
    Locale,
}
