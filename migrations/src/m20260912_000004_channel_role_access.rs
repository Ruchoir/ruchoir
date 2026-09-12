//! Which space roles may reach a channel.
//!
//! A row per allowed role. **No row at all means no restriction**, which is the state every existing
//! channel is in and the state a channel is created in unless someone says otherwise; a restricted
//! channel carries one row per role it admits. The alternative (a column listing the roles) would
//! have made "restricted to nobody" and "open to everybody" the same empty value.
//!
//! This sits on top of the channel's own type rather than replacing it: `public`/`private` answers
//! "who may join without being asked", this answers "who may be in it at all". A private channel
//! reserved to administrators is both, and means what the two words say together.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE channel_role_access ( \
                     channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, \
                     role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')), \
                     PRIMARY KEY (channel_id, role) \
                 );",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS channel_role_access;")
            .await?;
        Ok(())
    }
}
