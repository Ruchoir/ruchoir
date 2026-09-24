//! What a link preview needs to look like the site it points to: the site's own colour and a
//! thumbnail of its preview image.
//!
//! `color` is the page's `theme-color`, kept only when it is a plain hex colour. The image is fetched
//! by the server like the page (see `apps/api/src/messaging/unfurl.rs`), reduced to a thumbnail and
//! stored in the object store under `image_key`, then served from this instance: a reader's browser
//! never loads anything from the site. The dimensions are the original image's, for the aspect ratio
//! the card reserves before the thumbnail arrives.
//!
//! `image_file_id`, from the first version of the table, stays unused: a preview image is not a file
//! of any space and must not appear in one.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE message_link_previews \
                     ADD COLUMN color text, \
                     ADD COLUMN image_key text, \
                     ADD COLUMN image_width integer, \
                     ADD COLUMN image_height integer;",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE message_link_previews \
                     DROP COLUMN IF EXISTS color, \
                     DROP COLUMN IF EXISTS image_key, \
                     DROP COLUMN IF EXISTS image_width, \
                     DROP COLUMN IF EXISTS image_height;",
            )
            .await?;
        Ok(())
    }
}
