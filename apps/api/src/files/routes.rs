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

use super::{download, images, shares, tree, uploads};

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
            post(uploads::upload_version),
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
