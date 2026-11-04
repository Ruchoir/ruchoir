//! An access rule remembers who last set it, and when.
//!
//! `permission_overrides.set_by` is the person who last created or changed the rule, and `set_at`
//! the moment they did. Both stay `NULL` for the rules that exist before this migration, and for
//! a rule written by something that is not a person. The author's account going away clears
//! `set_by` (`ON DELETE SET NULL`); the rule stays.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
ALTER TABLE permission_overrides
    ADD COLUMN set_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN set_at timestamptz;
"#;

const DOWN: &str = r#"
ALTER TABLE permission_overrides
    DROP COLUMN IF EXISTS set_at,
    DROP COLUMN IF EXISTS set_by;
"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(DOWN).await?;
        Ok(())
    }
}
