//! Error type for the files surface, and its HTTP representation.
//!
//! Like the messaging errors, responses are terse and uniform and never leak internals. Authorization
//! failures collapse to a flat `403` that does not distinguish "does not exist" from "not allowed to
//! see it", so the API never confirms a file's existence to someone who cannot access it. `NotFound`
//! is used only once the caller is already allowed to address the resource (for example a file whose
//! bytes were never uploaded, or a soft-deleted file a space member asked for by id).

use axum::extract::multipart::MultipartError;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::storage::StorageError;

/// Errors surfaced by the file endpoints.
#[derive(Debug)]
pub enum FileError {
    /// The resource does not exist (only used when the caller may know that).
    NotFound,
    /// The caller is authenticated but not allowed to perform or see this.
    Forbidden,
    /// The request is malformed or violates a simple rule. The static reason is safe to expose.
    BadRequest(&'static str),
    /// The upload is larger than the configured maximum.
    PayloadTooLarge(&'static str),
    /// Object storage is not configured, so file bytes cannot be served.
    StorageUnavailable,
    /// The object-storage backend failed.
    Storage,
    /// An office document could not be converted to PDF for preview.
    Conversion,
    /// Any unexpected server-side failure. Never leaks internals to the client.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for FileError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            FileError::NotFound => (StatusCode::NOT_FOUND, "not_found", "Resource not found."),
            FileError::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "You do not have access to this resource.",
            ),
            FileError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            FileError::PayloadTooLarge(message) => {
                (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", message)
            }
            FileError::StorageUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                "File storage is not available.",
            ),
            FileError::Storage => (
                StatusCode::BAD_GATEWAY,
                "storage_error",
                "The object store could not be reached.",
            ),
            FileError::Conversion => (
                StatusCode::BAD_GATEWAY,
                "conversion_failed",
                "The document could not be converted for preview.",
            ),
            FileError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An unexpected error occurred.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

/// Any database error becomes an opaque `500`: the detail is logged, never sent to the client.
impl From<sea_orm::DbErr> for FileError {
    fn from(error: sea_orm::DbErr) -> Self {
        tracing::error!(%error, "database error in files handler");
        FileError::Internal
    }
}

/// An object-store failure becomes a `502`: logged, never surfaced in detail.
impl From<StorageError> for FileError {
    fn from(error: StorageError) -> Self {
        tracing::error!(%error, "object store error in files handler");
        FileError::Storage
    }
}

/// A malformed multipart body is a client error.
impl From<MultipartError> for FileError {
    fn from(error: MultipartError) -> Self {
        tracing::debug!(%error, "malformed multipart upload");
        FileError::BadRequest("malformed multipart upload")
    }
}
