//! The public, authenticated side: open a file in the editor, create a blank document.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::EntityTrait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::files::authz;
use crate::files::dto::FileDto;
use crate::files::error::FileError;
use crate::files::versions;
use crate::state::AppState;

use super::discovery::Mode;
use super::error::OfficeError;
use super::templates::{self, Kind};
use super::tokens;

/// What the client says about the person opening the file.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct SessionRequest {
    /// Interface language (`fr`, `en`, `es`, `de`, `it`, `pl`).
    pub locale: Option<String>,
    /// `light` or `dark`, from the person's theme.
    pub theme: Option<String>,
    /// The person's accent (`sky`, `mint`, `violet`, `pink`).
    pub accent: Option<String>,
    /// Ruchoir or a simplified style (`aubergine`, `nuage`, `indigo`, `marine`); absent or unknown
    /// is Ruchoir.
    pub style: Option<String>,
    /// `convert` to convert a legacy format into an editable copy.
    pub mode: Option<String>,
    /// A touch screen (phone, tablet): the engine's mobile editor.
    pub mobile: Option<bool>,
    /// The desktop app's own origin (`office_desktop_embed`): the editor then posts its messages
    /// there instead of to the instance's origin. Only the desktop origins are accepted.
    pub embed_origin: Option<String>,
}

/// An editing session: where to post the token, and what to tell the engine.
#[derive(Debug, Serialize, ToSchema)]
pub struct SessionResponse {
    pub file: FileDto,
    /// The engine's address for this file, on the office hostname.
    pub url: String,
    pub access_token: String,
    /// Expiry of the token, in milliseconds since the epoch (as WOPI expects it).
    pub access_token_ttl: i64,
    pub mode: Mode,
    /// Euro-Office's `docs_api_config`, a JSON string posted with the token.
    pub config: String,
    /// The member's display name: without a photo, Ruchoir draws their default avatar from it (it
    /// is generated in the browser) and gives it to the editor.
    pub member_name: String,
}

/// `POST /api/v1/files/{file_id}/office`.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/office",
    tag = "office",
    params(("file_id" = Uuid, Path, description = "File id")),
    request_body = SessionRequest,
    responses(
        (status = 200, description = "Session opened", body = SessionResponse),
        (status = 400, description = "The editor cannot open this format"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "Live editing is not configured"),
        (status = 503, description = "The editor is not available right now")
    )
)]
pub async fn open_session(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Json(request): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, OfficeError> {
    let office = state.office.as_ref().ok_or(OfficeError::Disabled)?;
    let discovery = office.discovery().ok_or(OfficeError::EngineUnavailable)?;
    // Whoever the origin names receives the editor's messages, so it is a fixed list, not an echo.
    if let Some(origin) = request.embed_origin.as_deref() {
        if !super::DESKTOP_ORIGINS.contains(&origin) {
            return Err(FileError::BadRequest("invalid embed_origin").into());
        }
    }
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    if access.file.kind == "folder" {
        return Err(OfficeError::Unsupported);
    }
    let ext = extension(&access.file.name).ok_or(OfficeError::Unsupported)?;
    let actions = discovery.actions(&ext).ok_or(OfficeError::Unsupported)?;
    let may_edit = match authz::ensure_content_editable(&state.db, file_id, session.user_id).await {
        Ok(_) => true,
        Err(FileError::Forbidden) => false,
        Err(error) => return Err(error.into()),
    };
    let mode = if request.mode.as_deref() == Some("convert") {
        if !may_edit || actions.convert.is_none() {
            return Err(OfficeError::Unsupported);
        }
        Mode::Convert
    } else if may_edit && actions.edit.is_some() {
        Mode::Edit
    } else if actions.view.is_some() || actions.edit.is_some() {
        Mode::View
    } else {
        return Err(OfficeError::Unsupported);
    };
    let lang = engine_language(request.locale.as_deref());
    let wopi_src = format!("{}/wopi/files/{file_id}", state.config.wopi_base_url);
    let url = discovery
        .action_url(&ext, mode, &wopi_src, lang, request.mobile == Some(true))
        .ok_or(OfficeError::Unsupported)?;
    let (token, grant) = tokens::mint(
        &state.valkey,
        session.user_id,
        file_id,
        mode,
        state.config.office_token_ttl_secs,
        request.embed_origin.clone(),
    )
    .await?;
    // The member's Ruchoir photo, for the editor's own avatar (and the co-authors'): served by
    // Ruchoir's host, which is the same site as the editor's, so the session cookie goes with it.
    let member = crate::entities::users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?;
    let member_name = member
        .as_ref()
        .map(|user| user.display_name.clone())
        .unwrap_or_default();
    let photo = member.and_then(|user| {
        let key = user.avatar_key?;
        Some(format!(
            "{}{}",
            state.config.public_base_url.trim_end_matches('/'),
            crate::files::avatar_url(user.id, &key)
        ))
    });
    let file = crate::files::hydrate_files(&state.db, vec![access.file])
        .await?
        .pop()
        .ok_or(OfficeError::Internal)?;
    Ok(Json(SessionResponse {
        file,
        url,
        access_token: token,
        access_token_ttl: grant.expires_at * 1000,
        mode,
        config: engine_config(
            state.config.public_base_url.trim_end_matches('/'),
            request.theme.as_deref(),
            request.accent.as_deref(),
            request.style.as_deref(),
            lang,
            photo.as_deref(),
        ),
        member_name,
    }))
}

/// A blank document to create.
#[derive(Debug, Deserialize, ToSchema)]
pub struct BlankRequest {
    pub space_id: Uuid,
    pub folder_id: Option<Uuid>,
    pub kind: Kind,
    pub name: String,
    pub locale: Option<String>,
}

/// `POST /api/v1/files/office`: create a blank document.
#[utoipa::path(
    post,
    path = "/api/v1/files/office",
    tag = "office",
    request_body = BlankRequest,
    responses(
        (status = 201, description = "Document created", body = FileDto),
        (status = 400, description = "Invalid folder"),
        (status = 403, description = "Not a member of the space, or a guest"),
        (status = 404, description = "Live editing is not configured")
    )
)]
pub async fn create_blank(
    State(state): State<AppState>,
    session: AuthSession,
    Json(request): Json<BlankRequest>,
) -> Result<(StatusCode, Json<FileDto>), OfficeError> {
    state.office.as_ref().ok_or(OfficeError::Disabled)?;
    // `files.create` on the space: this already refuses a guest of it.
    authz::ensure_space_files_creator(&state.db, request.space_id, session.user_id).await?;
    if let Some(folder_id) = request.folder_id {
        crate::files::tree::ensure_folder_in_space(&state.db, folder_id, request.space_id).await?;
    }
    let ext = request.kind.extension();
    let cleaned = crate::files::tree::clean_name(&request.name);
    // A typed extension is not doubled, whatever its case (`Notes.DOCX` gives `Notes.docx`).
    let suffix = format!(".{ext}");
    let stem = match cleaned.len().checked_sub(suffix.len()) {
        Some(at) if cleaned.is_char_boundary(at) && cleaned[at..].eq_ignore_ascii_case(&suffix) => {
            &cleaned[..at]
        }
        _ => cleaned.as_str(),
    }
    .trim();
    let stem = if stem.is_empty() { "Document" } else { stem };
    let name = versions::free_name(
        &state.db,
        request.space_id,
        request.folder_id,
        None,
        stem,
        ext,
    )
    .await?;
    let file = versions::create_file(
        &state,
        versions::NewFile {
            space_id: request.space_id,
            folder_id: request.folder_id,
            conversation_id: None,
            owner: session.user_id,
            name,
        },
        templates::blank(request.kind, request.locale.as_deref()),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(file)))
}

/// The engine language for an interface locale (European paper sizes; French by default).
pub fn engine_language(locale: Option<&str>) -> &'static str {
    match locale {
        Some("en") => "en-GB",
        Some("es") => "es-ES",
        Some("de") => "de-DE",
        Some("it") => "it-IT",
        Some("pl") => "pl-PL",
        _ => "fr-FR",
    }
}

/// One of the simplified styles, or `None` for Ruchoir (absent, or a name this instance does not know).
fn known_style(style: Option<&str>) -> Option<&'static str> {
    match style {
        Some("aubergine") => Some("aubergine"),
        Some("nuage") => Some("nuage"),
        Some("indigo") => Some("indigo"),
        Some("marine") => Some("marine"),
        _ => None,
    }
}

/// The colour laid over the editor on what is selected or active: a simplified style's tint (its
/// `--acc` in the design system's `tokens.css`, checked by `apps/web/tools/office-themes`), else
/// one of Ruchoir's accents, sky by default. Only these reach the engine's page, which writes the
/// colour into a style sheet.
fn accent_colour(style: Option<&str>, accent: Option<&str>) -> &'static str {
    match (known_style(style), accent) {
        (Some("aubergine"), _) => "#b9d7f0",
        (Some("nuage"), _) => "#b3dcf3",
        (Some("indigo"), _) => "#c5c8f5",
        (Some("marine"), _) => "#b8cdf6",
        (_, Some("mint")) => "#6fe0c2",
        (_, Some("violet")) => "#c9a8ff",
        (_, Some("pink")) => "#f5b0f0",
        _ => "#8fd0ff",
    }
}

/// The engine theme: its own dark one by night (a custom dark theme is never painted, upstream
/// defect 3), else the style's day theme (`infra/office/themes`), Ruchoir's by default.
fn ui_theme(theme: Option<&str>, style: Option<&str>) -> String {
    if theme == Some("dark") {
        return "theme-dark".to_owned();
    }
    match known_style(style) {
        Some(style) => format!("theme-ruchoir-{style}-light"),
        None => "theme-ruchoir-light".to_owned(),
    }
}

/// Euro-Office's configuration for a session, ignored by other engines. `ruchoir.accent` is read by
/// the patched WOPI page (`infra/office/patches/editor-wopi.ejs`), which paints the editor with it.
fn engine_config(
    public_base_url: &str,
    theme: Option<&str>,
    accent: Option<&str>,
    style: Option<&str>,
    lang: &str,
    photo: Option<&str>,
) -> String {
    let ui_theme = ui_theme(theme, style);
    let mut config = json!({
        "editorConfig": {
            "lang": lang,
            "customization": {
                "uiTheme": ui_theme,
                // The "New" bubbles sell the engine and are half English.
                "features": { "featuresTips": false },
                "logo": {
                    "image": format!("{public_base_url}/brand/ruchoir-mark.png"),
                    "url": public_base_url,
                },
                "customer": { "name": "Ruchoir", "www": public_base_url },
            },
        },
        "ruchoir": { "accent": accent_colour(style, accent) },
    });
    if let Some(photo) = photo {
        config["editorConfig"]["user"] = json!({ "image": photo });
    }
    config.to_string()
}

/// The lower-case extension of a file name.
fn extension(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    (!ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// `GET /api/v1/files/{file_id}/office/converted`: the copy this member's conversion of the file
/// produced, once the engine has written it. The editor page asks while converting, then names the
/// copy and reports editing it rather than the original.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/office/converted",
    tag = "office",
    params(("file_id" = Uuid, Path, description = "The original file id")),
    responses(
        (status = 200, description = "The converted copy", body = FileDto),
        (status = 204, description = "No copy yet"),
        (status = 403, description = "No access to the file")
    )
)]
pub async fn converted_copy(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<axum::response::Response, OfficeError> {
    use axum::response::IntoResponse;

    state.office.as_ref().ok_or(OfficeError::Disabled)?;
    authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let Some(copy_id) = tokens::copy_of(&state.valkey, file_id, session.user_id).await? else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let copy = match authz::ensure_readable(&state.db, copy_id, session.user_id).await {
        Ok(access) => access.file,
        Err(FileError::NotFound | FileError::Forbidden) => {
            return Ok(StatusCode::NO_CONTENT.into_response())
        }
        Err(error) => return Err(error.into()),
    };
    let dto = crate::files::hydrate_files(&state.db, vec![copy])
        .await?
        .pop()
        .ok_or(OfficeError::Internal)?;
    Ok(Json(dto).into_response())
}

/// Which editor tab a heartbeat comes from: a member may have the same file open in several.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct HeartbeatQuery {
    /// A random id the tab keeps for its life (letters, digits, `-`, `_`; at most 64).
    pub tab: Option<String>,
}

impl HeartbeatQuery {
    fn tab(&self) -> Result<&str, OfficeError> {
        let tab = self.tab.as_deref().unwrap_or("page");
        if super::presence::valid_tab(tab) {
            Ok(tab)
        } else {
            Err(FileError::BadRequest("invalid tab id").into())
        }
    }
}

/// `POST /api/v1/files/{file_id}/office/heartbeat`: the editor page is still open.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/office/heartbeat",
    tag = "office",
    params(("file_id" = Uuid, Path, description = "File id"), HeartbeatQuery),
    responses(
        (status = 204, description = "Noted"),
        (status = 400, description = "Invalid tab id"),
        (status = 403, description = "May not edit this file")
    )
)]
pub async fn heartbeat(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Query(query): Query<HeartbeatQuery>,
) -> Result<StatusCode, OfficeError> {
    state.office.as_ref().ok_or(OfficeError::Disabled)?;
    let tab = query.tab()?;
    let access = authz::ensure_content_editable(&state.db, file_id, session.user_id).await?;
    if super::presence::beat(&state.valkey, file_id, session.user_id, tab).await? {
        super::presence::publish(&state, &access.file, session.user_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/files/{file_id}/office/heartbeat`: the editor page was closed.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}/office/heartbeat",
    tag = "office",
    params(("file_id" = Uuid, Path, description = "File id"), HeartbeatQuery),
    responses((status = 204, description = "Noted"), (status = 400, description = "Invalid tab id"))
)]
pub async fn end_heartbeat(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Query(query): Query<HeartbeatQuery>,
) -> Result<StatusCode, OfficeError> {
    state.office.as_ref().ok_or(OfficeError::Disabled)?;
    let tab = query.tab()?;
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    if super::presence::leave(&state.valkey, file_id, session.user_id, tab).await? {
        super::presence::publish(&state, &access.file, session.user_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn config_of(theme: Option<&str>, accent: Option<&str>, style: Option<&str>) -> Value {
        serde_json::from_str(&engine_config(
            "https://r.test",
            theme,
            accent,
            style,
            "fr-FR",
            None,
        ))
        .unwrap()
    }

    fn accent_of(accent: Option<&str>) -> Value {
        config_of(None, accent, None)["ruchoir"]["accent"].clone()
    }

    #[test]
    fn the_editor_takes_the_styles_tint() {
        let tint = |style| config_of(None, Some("violet"), style)["ruchoir"]["accent"].clone();
        assert_eq!(tint(Some("aubergine")), "#b9d7f0");
        assert_eq!(tint(Some("nuage")), "#b3dcf3");
        assert_eq!(tint(Some("indigo")), "#c5c8f5");
        assert_eq!(tint(Some("marine")), "#b8cdf6");
        assert_eq!(
            tint(Some("bogus")),
            "#c9a8ff",
            "an unknown style keeps the accent"
        );
        assert_eq!(tint(None), "#c9a8ff", "no style keeps the accent");
    }

    #[test]
    fn the_editor_wears_the_styles_theme_by_day() {
        let theme = |theme, style| {
            config_of(theme, None, style)["editorConfig"]["customization"]["uiTheme"].clone()
        };
        assert_eq!(
            theme(Some("light"), Some("nuage")),
            "theme-ruchoir-nuage-light"
        );
        assert_eq!(theme(None, Some("marine")), "theme-ruchoir-marine-light");
        assert_eq!(
            theme(Some("dark"), Some("nuage")),
            "theme-dark",
            "the engine's night"
        );
        assert_eq!(theme(Some("light"), Some("bogus")), "theme-ruchoir-light");
        assert_eq!(theme(Some("light"), None), "theme-ruchoir-light");
    }

    #[test]
    fn the_editor_takes_the_members_accent() {
        assert_eq!(accent_of(Some("violet")), "#c9a8ff");
        assert_eq!(accent_of(Some("mint")), "#6fe0c2");
        assert_eq!(accent_of(Some("pink")), "#f5b0f0");
        assert_eq!(accent_of(Some("sky")), "#8fd0ff");
        assert_eq!(accent_of(None), "#8fd0ff", "Ruchoir's default accent");
        assert_eq!(
            accent_of(Some("#ff0000;}")),
            "#8fd0ff",
            "only Ruchoir's own accents reach the engine's page"
        );
    }
}
