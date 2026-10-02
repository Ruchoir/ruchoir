//! Errors of the office surface.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::files::error::FileError;

#[derive(Debug)]
pub enum OfficeError {
    /// Live editing is not configured on this instance.
    Disabled,
    /// The engine did not answer, or its discovery is not known yet.
    EngineUnavailable,
    /// The engine's discovery document could not be read.
    Discovery(&'static str),
    /// The file's format cannot be opened in the editor (or not in the mode asked).
    Unsupported,
    /// A file-surface refusal (rights, missing file, storage).
    File(FileError),
    /// Anything else, logged where it happens.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for OfficeError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            OfficeError::Disabled => (
                StatusCode::NOT_FOUND,
                "office_disabled",
                "Live editing is not available on this instance.",
            ),
            OfficeError::EngineUnavailable | OfficeError::Discovery(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "office_unavailable",
                "The editor is not available right now.",
            ),
            OfficeError::Unsupported => (
                StatusCode::BAD_REQUEST,
                "office_unsupported",
                "This file cannot be opened in the editor.",
            ),
            OfficeError::File(error) => return error.into_response(),
            OfficeError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An unexpected error occurred.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

impl std::fmt::Display for OfficeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OfficeError::Disabled => write!(f, "live editing disabled"),
            OfficeError::EngineUnavailable => write!(f, "office engine unavailable"),
            OfficeError::Discovery(why) => write!(f, "office discovery unreadable: {why}"),
            OfficeError::Unsupported => write!(f, "format not supported by the engine"),
            OfficeError::File(error) => write!(f, "file error: {error:?}"),
            OfficeError::Internal => write!(f, "internal error"),
        }
    }
}

impl From<FileError> for OfficeError {
    fn from(error: FileError) -> Self {
        OfficeError::File(error)
    }
}

impl From<sea_orm::DbErr> for OfficeError {
    fn from(error: sea_orm::DbErr) -> Self {
        tracing::error!(%error, "database error in office handler");
        OfficeError::Internal
    }
}
