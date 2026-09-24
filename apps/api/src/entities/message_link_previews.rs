//! The `message_link_previews` table: server-fetched link unfurls.
//!
//! Titles, colours and thumbnails are fetched and stored server-side (`messaging::unfurl`), never
//! resolved in the browser, so a viewer can never be used to probe arbitrary URLs. The thumbnail
//! lives in the object store under `image_key` and is served by this instance, never hotlinked.
//! `image_file_id` is a leftover of the first schema and stays empty.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "message_link_previews")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub message_id: Uuid,
    pub url: String,
    pub domain: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_file_id: Option<Uuid>,
    /// The page's `theme-color`, as `#rrggbb`.
    pub color: Option<String>,
    /// Object-store key of the JPEG thumbnail of the page's preview image.
    pub image_key: Option<String>,
    /// The original image's width and height, for the aspect ratio.
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub fetched_at: TimeDateTimeWithTimeZone,
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
