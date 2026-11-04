//! What an import of people (permissions lot 6) leaves behind.
//!
//! - `space_members.imported_from` and `space_groups.imported_from` remember which import brought
//!   a person or a group (`<source>:<job id>`); `NULL` for anything made by hand.
//! - `import_jobs.summary` holds what the run did with people, written when it finishes, and
//!   `import_jobs.attempt` counts how many times the job has run (a resume raises it), so each attempt
//!   journals its own line.
//!
//! The audit log needs nothing: its `action` column is free text, so `import.applied` fits as is.
//! DOWN drops the columns and never touches the audit log's rows.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
ALTER TABLE space_members ADD COLUMN imported_from text;
ALTER TABLE space_groups ADD COLUMN imported_from text;
ALTER TABLE import_jobs ADD COLUMN summary jsonb;
ALTER TABLE import_jobs ADD COLUMN attempt integer NOT NULL DEFAULT 0;
"#;

const DOWN: &str = r#"
ALTER TABLE import_jobs DROP COLUMN IF EXISTS attempt;
ALTER TABLE import_jobs DROP COLUMN IF EXISTS summary;
ALTER TABLE space_groups DROP COLUMN IF EXISTS imported_from;
ALTER TABLE space_members DROP COLUMN IF EXISTS imported_from;
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
