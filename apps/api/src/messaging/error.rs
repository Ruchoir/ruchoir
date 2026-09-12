//! Error type for the messaging and real-time surface, and its HTTP representation.
//!
//! Like the auth errors, responses are terse and uniform: a small JSON `{error, message}` body,
//! never leaking internals, database detail or private message content. Authorization failures are
//! deliberately a flat `403 forbidden` that does not distinguish "does not exist" from "not allowed
//! to see it", so the API never confirms the existence of a resource to someone who cannot access
//! it. Use [`ApiError::NotFound`] only for resources the caller is already allowed to address.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Errors surfaced by the messaging and real-time endpoints.
#[derive(Debug)]
pub enum ApiError {
    /// The addressed resource does not exist (only used when the caller may know that).
    NotFound,
    /// The caller is authenticated but not allowed to perform or see this.
    Forbidden,
    /// The request is malformed or violates a simple rule. The static reason is safe to expose.
    BadRequest(&'static str),
    /// The request is well formed and allowed, but the current state refuses it. Distinct from
    /// [`ApiError::BadRequest`] because nothing about the request needs fixing: a last owner asking
    /// to leave their space has sent a perfectly good request, and has to change the space (hand
    /// ownership over, or delete it) rather than the call. The static reason is safe to expose.
    Conflict(&'static str),
    /// No valid session. Mirrors the auth guard's 401 so the client reacts identically.
    Unauthorized,
    /// Any unexpected server-side failure. Never leaks internals to the client.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found", "Resource not found."),
            ApiError::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "You do not have access to this resource.",
            ),
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            ApiError::Conflict(message) => (StatusCode::CONFLICT, "conflict", message),
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Authentication required.",
            ),
            ApiError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An unexpected error occurred.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

/// Any database error becomes an opaque `500`: the detail is logged, never sent to the client.
impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        tracing::error!(%error, "database error in messaging handler");
        ApiError::Internal
    }
}
