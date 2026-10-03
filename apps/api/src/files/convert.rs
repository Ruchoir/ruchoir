//! Office documents shown as PDF: a word-processing, spreadsheet or presentation file is converted
//! by LibreOffice (The Document Foundation, Germany) and the viewer displays the result like any
//! other PDF, so one path covers every format and printing works the same everywhere.
//!
//! The converter is a separate process, run on a copy of the bytes in a throwaway directory, with
//! its own profile, a cleared environment (none of the API's secrets reach it), a time limit and a
//! cap on how many run at once. The result is kept in the object store next to the version it was
//! made from, so a document is converted once and a later open is a plain read.

use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::Response;
use tokio::process::Command;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::state::AppState;

use super::authz;
use super::download::{
    build_response, current_version, is_fresh, not_modified, version_etag, with_validator,
    PREVIEW_CSP,
};
use super::error::FileError;

/// How long one conversion may run before it is killed.
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(90);
/// How many conversions may run at the same time: each one is a whole office suite in memory.
const MAX_CONCURRENT: usize = 2;

/// The office formats LibreOffice converts here, with the extension its importer needs on the input.
const OFFICE_EXTENSIONS: [&str; 10] = [
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "csv",
];

/// The script that drives LibreOffice (see its own header for why it is not a plain command line).
const CONVERT_SCRIPT: &str = include_str!("convert.py");

/// The extension to give the converter's input, when the file is an office document.
///
/// The MIME sniffed from the bytes decides first. A Word file is often only recognised as a plain
/// archive (`application/zip`), and an old binary one as a generic blob, so for those the name's
/// extension picks the format, from the list above and nothing else: the name the uploader gave is
/// never put on the input as such, and a file that is not what its name says simply fails to convert.
pub(crate) fn office_extension(mime: &str, name: &str) -> Option<&'static str> {
    let by_mime = match mime {
        "application/msword" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.ms-powerpoint" => Some("ppt"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        "application/vnd.oasis.opendocument.text" => Some("odt"),
        "application/vnd.oasis.opendocument.spreadsheet" => Some("ods"),
        "application/vnd.oasis.opendocument.presentation" => Some("odp"),
        _ => None,
    };
    if by_mime.is_some() {
        return by_mime;
    }
    let generic = matches!(
        mime,
        "application/zip"
            | "application/octet-stream"
            | "application/x-ole-storage"
            | "application/x-cfb"
            | "text/csv"
    );
    if !generic {
        return None;
    }
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    OFFICE_EXTENSIONS
        .into_iter()
        .find(|known| *known == extension)
}

/// Where the converted PDF of a version is kept, next to its bytes.
pub(crate) fn pdf_key(object_key: &str) -> String {
    format!("{object_key}.pdf")
}

/// `GET /api/v1/files/{file_id}/document`: the current version of an office file, as a PDF.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/document",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The document converted to PDF, inline"),
        (status = 400, description = "Not an office document"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "File or its bytes not found"),
        (status = 502, description = "The conversion failed"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn preview_document(
    State(state): State<AppState>,
    session: AuthSession,
    headers: HeaderMap,
    Path(file_id): Path<Uuid>,
) -> Result<Response, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let file = access.file;
    if file.kind == "folder" {
        return Err(FileError::BadRequest("cannot convert a folder"));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let version = current_version(&state.db, &file).await?;
    let extension = office_extension(&version.mime_type, &file.name)
        .ok_or(FileError::BadRequest("not an office document"))?;
    let tag = version_etag(version.id);
    if is_fresh(&headers, &tag) {
        return not_modified(&tag);
    }
    let pdf = document_pdf(storage, &version, extension).await?;

    let stem = file
        .name
        .rsplit_once('.')
        .map_or(file.name.as_str(), |(s, _)| s);
    let mut response = build_response(
        pdf,
        "application/pdf",
        "inline",
        &format!("{stem}.pdf"),
        false,
    )?;
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PREVIEW_CSP),
    );
    with_validator(&mut response, &tag);
    Ok(response)
}

/// A version of an office document as a PDF, converted once and kept next to its bytes.
pub(crate) async fn document_pdf(
    storage: &crate::storage::S3Store,
    version: &crate::entities::file_versions::Model,
    extension: &str,
) -> Result<Vec<u8>, FileError> {
    let key = version.storage_key.as_deref().ok_or(FileError::NotFound)?;
    let cache_key = pdf_key(key);
    if let Ok(bytes) = storage.get(&cache_key).await {
        return Ok(bytes);
    }
    let source = storage.get(key).await?;
    let pdf = convert_to_pdf(&source, extension).await?;
    // A failure to keep the result costs a second conversion next time, not the preview.
    if let Err(error) = storage.put(&cache_key, &pdf, "application/pdf").await {
        tracing::warn!(%error, "could not keep a converted preview");
    }
    Ok(pdf)
}

/// A version of an office document's first page, as a picture no wider than `max_px`, made once
/// and kept next to its bytes.
pub(crate) async fn document_page(
    storage: &crate::storage::S3Store,
    version: &crate::entities::file_versions::Model,
    extension: &str,
    max_px: u32,
) -> Result<Vec<u8>, FileError> {
    let key = version.storage_key.as_deref().ok_or(FileError::NotFound)?;
    let cache_key = format!("{key}.page1");
    if let Ok(bytes) = storage.get(&cache_key).await {
        return Ok(bytes);
    }
    let source = storage.get(key).await?;
    let png = convert_to_page(&source, extension).await?;
    let picture = super::thumbnail::make_thumbnail(&png, max_px)
        .map_err(|_| FileError::Conversion)?
        .thumbnail;
    if let Err(error) = storage
        .put(&cache_key, &picture, super::thumbnail::THUMBNAIL_MIME)
        .await
    {
        tracing::warn!(%error, "could not keep a document's first page");
    }
    Ok(picture)
}

/// Run LibreOffice on `source` and return the PDF it writes.
async fn convert_to_pdf(source: &[u8], extension: &str) -> Result<Vec<u8>, FileError> {
    convert(source, extension, "output.pdf").await
}

/// Run LibreOffice on `source` and return the picture of its first page (PNG).
async fn convert_to_page(source: &[u8], extension: &str) -> Result<Vec<u8>, FileError> {
    convert(source, extension, "output.png").await
}

/// Run LibreOffice on `source`, writing `output` (its extension picks a PDF or a page picture).
async fn convert(source: &[u8], extension: &str, output: &str) -> Result<Vec<u8>, FileError> {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(MAX_CONCURRENT))
        .acquire()
        .await
        .map_err(|_| FileError::Internal)?;

    let dir = std::env::temp_dir().join(format!("ruchoir-convert-{}", Uuid::new_v4()));
    let result = run_conversion(&dir, source, extension, output).await;
    if let Err(error) = tokio::fs::remove_dir_all(&dir).await {
        tracing::warn!(%error, "could not remove a conversion directory");
    }
    result
}

async fn run_conversion(
    dir: &FsPath,
    source: &[u8],
    extension: &str,
    output: &str,
) -> Result<Vec<u8>, FileError> {
    let fail = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "office conversion failed");
        FileError::Conversion
    };
    tokio::fs::create_dir_all(dir).await.map_err(|e| fail(&e))?;
    let input: PathBuf = dir.join(format!("input.{extension}"));
    tokio::fs::write(&input, source)
        .await
        .map_err(|e| fail(&e))?;

    let script = dir.join("convert.py");
    tokio::fs::write(&script, CONVERT_SCRIPT)
        .await
        .map_err(|e| fail(&e))?;
    let mut child = Command::new("python3")
        .arg(&script)
        .arg(&input)
        .arg(dir.join(output))
        .arg(dir.join("profile"))
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| fail(&e))?;

    match tokio::time::timeout(CONVERSION_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => {}
        Ok(Ok(status)) => return Err(fail(&format!("exit status {status}"))),
        Ok(Err(error)) => return Err(fail(&error)),
        Err(_) => {
            let _ = child.kill().await;
            return Err(fail(&"timed out"));
        }
    }
    tokio::fs::read(dir.join(output))
        .await
        .map_err(|e| fail(&e))
}
