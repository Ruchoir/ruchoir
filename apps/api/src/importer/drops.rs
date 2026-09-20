//! Auto-delivery: an export command running on a source host hands its sealed archive straight to
//! this instance, so an administrator never has to `scp` it over or type its name.
//!
//! Three surfaces make that up. The import screen asks for a **drop token** (single-use, expiring),
//! shows the command that carries it, and lists the archives already present. The command, running
//! wherever the export runs, **drops** the sealed archive here with that token. None of it trusts
//! the token for anything but one upload into the import directory.
//!
//! The scripts themselves are served from `/tools`, from this instance's own domain, so the
//! one-liner has somewhere of the administrator's own to fetch them from.

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::auth::tokens::{self, TokenPurpose};
use crate::messaging::error::ApiError;
use crate::state::AppState;

use super::routes::ensure_instance_admin;
use super::scripts;

/// How long a drop token is worth. Long enough to run an export of a real workspace, short enough
/// that a token left behind in a shell's history is not a standing door: an export that outlasts it
/// asks for a fresh command rather than holding one open for days.
const DROP_TOKEN_TTL_SECS: i64 = 6 * 3600;

/// A ceiling on a single delivered archive. A real migration is gigabytes, so this is generous; it
/// is only here so a broken or hostile uploader cannot fill the disk without any limit at all.
const MAX_DROP_BYTES: u64 = 200 * 1024 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    // The drop is the one route that takes a workspace-sized body, so the default request-body cap
    // is lifted for it alone rather than for the whole surface.
    let drop = Router::new()
        .route("/api/v1/imports/drop", put(drop_archive))
        .layer(DefaultBodyLimit::disable());

    Router::new()
        .route("/api/v1/imports/drop-tokens", post(issue_drop_token))
        .route("/api/v1/imports/files", get(list_files))
        .merge(drop)
        .route("/tools/export-nextcloud.sh", get(script_export_nextcloud))
        .route(
            "/tools/convert-mattermost.py",
            get(script_convert_mattermost),
        )
        .route("/tools/convert-slack.py", get(script_convert_slack))
        .route("/tools/import-nextcloud.sh", get(script_import_nextcloud))
        .route("/tools/import-mattermost.sh", get(script_import_mattermost))
        .route("/tools/import-slack.sh", get(script_import_slack))
}

#[derive(Serialize)]
struct DropTokenResponse {
    /// The raw token, shown once inside the command and never stored here in the clear.
    token: String,
    /// This instance's own address, so the command fetches its scripts and delivers from the
    /// administrator's own domain.
    base_url: String,
    expires_in_secs: i64,
}

/// `POST /api/v1/imports/drop-tokens`: mint a one-time token for a delivery command.
async fn issue_drop_token(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<DropTokenResponse>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    if state.config.import_dir.is_none() {
        return Err(ApiError::BadRequest(
            "this instance accepts no delivered archive: set the import directory first",
        ));
    }
    let token = tokens::issue(
        &state.valkey,
        TokenPurpose::ImportDrop,
        session.user_id,
        DROP_TOKEN_TTL_SECS,
    )
    .await
    .map_err(|_| ApiError::Internal)?;
    Ok(Json(DropTokenResponse {
        token,
        base_url: state
            .config
            .public_base_url
            .trim_end_matches('/')
            .to_owned(),
        expires_in_secs: DROP_TOKEN_TTL_SECS,
    }))
}

#[derive(Serialize)]
struct ArchiveFile {
    name: String,
    bytes: u64,
    /// Last modified, RFC 3339, so the screen can show the most recent first and an administrator
    /// can tell a fresh delivery from one that was already there.
    modified: Option<String>,
}

/// `GET /api/v1/imports/files`: the archives sitting in the import directory, newest first.
///
/// This is what lets the screen offer a choice instead of a text field, and what it polls to notice
/// an archive a delivery command has just dropped.
async fn list_files(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<ArchiveFile>>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let mut out: Vec<ArchiveFile> = Vec::new();
    let Some(dir) = state.config.import_dir.clone() else {
        return Ok(Json(out));
    };
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Ok(Json(out));
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        // A dotfile is machinery, not an archive: a half-written upload or an editor's leftover.
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .map(|t| time::OffsetDateTime::from(t).to_string());
        out.push(ArchiveFile {
            name,
            bytes: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(Json(out))
}

#[derive(Serialize)]
struct DropResult {
    /// The name the archive was given here. It is generated, never the uploader's, so the delivery
    /// can name no path of its own.
    file: String,
    bytes: u64,
}

/// `PUT /api/v1/imports/drop`: receive a sealed archive, authorised by a one-time token.
///
/// The token is spent the moment it is recognised, so a second delivery on the same token fails.
/// The archive streams to disk under a name of our making: an upload never chooses where it lands.
async fn drop_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<DropResult>, ApiError> {
    let token = headers
        .get("x-drop-token")
        .and_then(|value| value.to_str().ok())
        .map(|raw| raw.trim().to_owned())
        .unwrap_or_default();
    // A missing or unknown token is a 404, not a 401: to anyone without one, this door is not here.
    if token.is_empty() {
        return Err(ApiError::NotFound);
    }
    let admin = tokens::consume(&state.valkey, TokenPurpose::ImportDrop, &token)
        .await
        .map_err(|_| ApiError::Internal)?;
    if admin.is_none() {
        return Err(ApiError::NotFound);
    }

    let Some(dir) = state.config.import_dir.clone() else {
        return Err(ApiError::BadRequest(
            "this instance accepts no delivered archive: set the import directory first",
        ));
    };
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ApiError::Internal)?;
    let name = format!("drop-{}.tar.gpg", Uuid::new_v4().simple());
    let path = dir.join(&name);

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut stream = body.into_data_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(ApiError::BadRequest("the upload was interrupted"));
            }
        };
        total += chunk.len() as u64;
        if total > MAX_DROP_BYTES {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(ApiError::BadRequest(
                "the delivered archive exceeds the maximum size",
            ));
        }
        if file.write_all(&chunk).await.is_err() {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(ApiError::Internal);
        }
    }
    if file.flush().await.is_err() {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ApiError::Internal);
    }

    Ok(Json(DropResult {
        file: name,
        bytes: total,
    }))
}

// --- Served scripts --------------------------------------------------------------------------

/// A shell script, served as text so `curl … | bash` reads it plainly.
fn shell(body: String) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")],
        body,
    )
}

async fn script_export_nextcloud() -> impl IntoResponse {
    shell(scripts::EXPORT_NEXTCLOUD_SH.to_owned())
}

async fn script_convert_mattermost() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/x-python; charset=utf-8")],
        scripts::CONVERT_MATTERMOST_PY.to_owned(),
    )
}

async fn script_convert_slack() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/x-python; charset=utf-8")],
        scripts::CONVERT_SLACK_PY.to_owned(),
    )
}

async fn script_import_nextcloud(State(state): State<AppState>) -> impl IntoResponse {
    shell(scripts::render(
        scripts::IMPORT_NEXTCLOUD_SH,
        &state.config.public_base_url,
    ))
}

async fn script_import_mattermost(State(state): State<AppState>) -> impl IntoResponse {
    shell(scripts::render(
        scripts::IMPORT_MATTERMOST_SH,
        &state.config.public_base_url,
    ))
}

async fn script_import_slack(State(state): State<AppState>) -> impl IntoResponse {
    shell(scripts::render(
        scripts::IMPORT_SLACK_SH,
        &state.config.public_base_url,
    ))
}
