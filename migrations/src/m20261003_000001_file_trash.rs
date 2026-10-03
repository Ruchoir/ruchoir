//! The trash: who removed a file, which removal it belongs to, and whether its bytes are gone.
//!
//! A removal was already soft (`deleted_at`), a folder taking its subtree with it, but nothing told
//! the folder that was removed from the files that went with it. `trashed` marks the root of a
//! removal: the one entry the trash lists and restores, everything removed with it coming back
//! too. `deleted_by` is who did it. `purged_at` is the end of the road: the bytes have been erased
//! from the object store and the row stays only as a tombstone, so an attachment that pointed at it
//! says "deleted" instead of breaking.
//!
//! Removals made before this migration become trash entries when their parent was not removed with
//! them, which is the closest reading of what the person did.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE files \
                 ADD COLUMN deleted_by uuid, \
                 ADD COLUMN trashed boolean NOT NULL DEFAULT false, \
                 ADD COLUMN purged_at timestamptz;",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE files f SET trashed = true \
             WHERE f.deleted_at IS NOT NULL \
               AND NOT EXISTS ( \
                 SELECT 1 FROM files p \
                 WHERE p.id = f.parent_folder_id AND p.deleted_at IS NOT NULL \
               );",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX idx_files_trash ON files (space_id, deleted_at) WHERE trashed;",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP INDEX IF EXISTS idx_files_trash; \
                 ALTER TABLE files \
                     DROP COLUMN IF EXISTS deleted_by, \
                     DROP COLUMN IF EXISTS trashed, \
                     DROP COLUMN IF EXISTS purged_at;",
            )
            .await?;
        Ok(())
    }
}
