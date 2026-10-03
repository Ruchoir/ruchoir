//! The files router: tree, upload/versions, download/preview/thumbnail, shares, message attachments,
//! and the avatar/icon images that are not files.
//!
//! Routes use absolute `/api/v1/...` paths and are merged into the main router in `http.rs`. A raised
//! request-body limit is applied to the whole sub-router (only the upload routes carry a body; the
//! GET routes have none), sized from the configured upload cap plus a small multipart overhead.

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::state::AppState;

use super::{convert, download, history, images, links, shares, trash, tree, uploads, views};

/// Build the files sub-router with `upload_max_bytes` as the request-body limit.
pub fn router(upload_max_bytes: usize) -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/files",
            get(tree::list_folder).post(uploads::upload_file),
        )
        .route(
            "/api/v1/spaces/{space_id}/folders",
            post(tree::create_folder),
        )
        .route(
            "/api/v1/files/{file_id}",
            patch(tree::update_file).delete(tree::delete_file),
        )
        // Attachments upload through their conversation: that is what decides their audience.
        .route(
            "/api/v1/conversations/{conversation_id}/attachments",
            post(uploads::upload_attachment),
        )
        // What was shared in one conversation, which is not the same question as what the space
        // holds: the channel file panel asks this one.
        .route(
            "/api/v1/conversations/{conversation_id}/files",
            get(tree::list_conversation_files),
        )
        // Avatars and space icons: their own keys, their own audiences, never files.
        .route(
            "/api/v1/users/me/avatar",
            put(images::set_my_avatar).delete(images::clear_my_avatar),
        )
        .route("/api/v1/users/{user_id}/avatar", get(images::get_avatar))
        .route(
            "/api/v1/spaces/{space_id}/icon",
            get(images::get_space_icon)
                .put(images::set_space_icon)
                .delete(images::clear_space_icon),
        )
        .route(
            "/api/v1/files/{file_id}/versions",
            get(history::list_versions).post(uploads::upload_version),
        )
        .route(
            "/api/v1/files/{file_id}/versions/{version_id}/download",
            get(history::download_version),
        )
        .route(
            "/api/v1/files/{file_id}/versions/{version_id}/restore",
            post(history::restore_version),
        )
        // The trash: what was removed, its restoring and its erasing for good.
        .route(
            "/api/v1/spaces/{space_id}/trash",
            get(trash::list_trash).delete(trash::empty_trash),
        )
        .route("/api/v1/files/{file_id}/restore", post(trash::restore_file))
        .route("/api/v1/files/{file_id}/trash", delete(trash::erase_file))
        // The views beyond a folder, and a person's favourites.
        .route("/api/v1/spaces/{space_id}/files/recent", get(views::recent))
        .route(
            "/api/v1/spaces/{space_id}/files/starred",
            get(views::starred),
        )
        .route(
            "/api/v1/spaces/{space_id}/files/shared",
            get(views::shared_with_me),
        )
        .route("/api/v1/spaces/{space_id}/files/search", get(views::search))
        .route(
            "/api/v1/files/{file_id}/star",
            put(views::star).delete(views::unstar),
        )
        // Public links: managed here, answered without a session by `links::public_router`.
        .route(
            "/api/v1/files/{file_id}/links",
            get(links::list_links).post(links::create_link),
        )
        .route(
            "/api/v1/files/{file_id}/links/{link_id}",
            delete(links::revoke_link),
        )
        .route(
            "/api/v1/files/{file_id}/download",
            get(download::download_file),
        )
        .route(
            "/api/v1/files/{file_id}/preview",
            get(download::preview_file),
        )
        .route(
            "/api/v1/files/{file_id}/document",
            get(convert::preview_document),
        )
        .route(
            "/api/v1/files/{file_id}/thumbnail",
            get(download::thumbnail_file),
        )
        .route(
            "/api/v1/files/{file_id}/shares",
            get(shares::list_shares).post(shares::create_share),
        )
        .route(
            "/api/v1/files/{file_id}/shares/{share_id}",
            delete(shares::delete_share),
        )
        .layer(DefaultBodyLimit::max(upload_max_bytes))
}
