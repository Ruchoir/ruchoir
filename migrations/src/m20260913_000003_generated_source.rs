//! Admitting an archive nobody exported.
//!
//! The import tables name the product a record came from, and the check constraint that guards
//! that column listed only real products. A generated archive, the kind used to run the importer
//! against the size of a real migration, says `synthetic` rather than borrowing a product's name:
//! the source is written into every mapping a run records, and a false one there outlives the test
//! that told it. Without this, such a run reads the archive, builds a plan, shows it, and then
//! fails on its first write.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const SOURCES: &str = "'nextcloud', 'mattermost', 'slack', 'teams', 'synthetic'";
const WITHOUT_GENERATED: &str = "'nextcloud', 'mattermost', 'slack', 'teams'";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in ["import_jobs", "import_mappings"] {
            let db = manager.get_connection();
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_source_check;"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} ADD CONSTRAINT {table}_source_check \
                 CHECK (source IN ({SOURCES}));"
            ))
            .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Going back narrows the column again, so anything generated has to go first: leaving the
        // rows would make the constraint unaddable and the rollback would fail halfway.
        let db = manager.get_connection();
        db.execute_unprepared("DELETE FROM import_mappings WHERE source = 'synthetic';")
            .await?;
        db.execute_unprepared("DELETE FROM import_jobs WHERE source = 'synthetic';")
            .await?;
        for table in ["import_jobs", "import_mappings"] {
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_source_check;"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} ADD CONSTRAINT {table}_source_check \
                 CHECK (source IN ({WITHOUT_GENERATED}));"
            ))
            .await?;
        }
        Ok(())
    }
}
