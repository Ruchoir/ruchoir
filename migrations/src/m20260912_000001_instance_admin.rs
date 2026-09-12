//! Instance administrator flag on `users`.
//!
//! The existing roles (`owner`, `admin`, `member`, `guest`) are held in `space_members` and are
//! therefore roles *inside one space*, while an account is global. Recovering an account someone
//! has locked themselves out of is an instance-wide act: letting the administrator of one space
//! perform it would hand them every other space that person belongs to.
//!
//! Set on the first account by the `bootstrap` subcommand. Nothing in the running server grants it,
//! by design: minting administrators is a decision taken at the console, and a later permissions
//! model can build on this column without contradicting it.
//!
//! It extends the `users` table (owned by the auth migration) through a new migration; the shipped
//! migrations are never edited.

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
                    .add_column(
                        ColumnDef::new(Users::IsInstanceAdmin)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        // An instance commissioned before this column existed has an administrator that predates
        // the flag: its first account is the one `bootstrap` created, and leaving it unmarked would
        // mean an upgraded instance has no administrator at all and no way to gain one without SQL.
        // Oldest account only, so this cannot mark anyone who merely signed up early.
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE users SET is_instance_admin = true WHERE id = \
                 (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .drop_column(Users::IsInstanceAdmin)
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
    IsInstanceAdmin,
}
