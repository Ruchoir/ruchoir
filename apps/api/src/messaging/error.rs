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
    /// The same `403`, with the reason as a code the client can explain (`role_above_you`,
    /// `person_above_you`, `permission_not_held`). `error` stays `forbidden`, so an app that does not
    /// know the reason reads it as before.
    ForbiddenBecause(&'static str),
    /// The request is malformed or violates a simple rule. The static reason is safe to expose.
    BadRequest(&'static str),
    /// The same, when the reason cannot be a fixed sentence. An archive says why it does not hold
    /// together (which file, which line, which checksum), and passing that through is the whole
    /// difference between an administrator fixing their export and guessing at it. Only ever built
    /// from text this side wrote, never from anything a caller sent.
    BadRequestOwned(String),
    /// The request is well formed and allowed, but the current state refuses it. Distinct from
    /// [`ApiError::BadRequest`] because nothing about the request needs fixing: a last owner asking
    /// to leave their space has sent a perfectly good request, and has to change the space (hand
    /// ownership over, or delete it) rather than the call. The static reason is safe to expose.
    Conflict(&'static str),
    /// A `400` whose `error` field is the code itself (`base_role_not_allowed`), with a fixed
    /// message, for a client that explains the refusal in its own words.
    BadRequestCode {
        code: &'static str,
        message: &'static str,
    },
    /// The same for a `409` (`group_name_taken`, `group_from_directory`).
    ConflictCode {
        code: &'static str,
        message: &'static str,
    },
    /// No valid session. Mirrors the auth guard's 401 so the client reacts identically.
    Unauthorized,
    /// Every one of the space's `seats` is taken, so no owner or member can be added: `402`, with
    /// where to buy more. Only an edition that sells seats ever answers it; guests can still come
    /// in, and nobody already there loses anything.
    SeatsFull { seats: u32, pricing_url: String },
    /// A paid change in a space without a licence: `402 licence_required`, with where to get one.
    LicenceRequired { pricing_url: String },
    /// A paid change in a space whose licence has expired: `409 licence_frozen`. What it
    /// configured keeps applying; it can no longer be changed until a licence is installed.
    LicenceFrozen,
    /// Any unexpected server-side failure. Never leaks internals to the client.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'static str,
    message: &'a str,
}

/// The body of a [`ApiError::SeatsFull`] refusal: the usual two fields, and what to do about it.
#[derive(Serialize)]
struct SeatsFullBody<'a> {
    error: &'static str,
    message: &'static str,
    seats: u32,
    pricing_url: &'a str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let ApiError::ForbiddenBecause(reason) = &self {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "forbidden",
                    "message": "You do not have access to this resource.",
                    "reason": reason,
                })),
            )
                .into_response();
        }
        if let ApiError::BadRequestCode { code, message }
        | ApiError::ConflictCode { code, message } = &self
        {
            let status = if matches!(self, ApiError::ConflictCode { .. }) {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            return (
                status,
                Json(serde_json::json!({ "error": code, "message": message })),
            )
                .into_response();
        }
        if let ApiError::LicenceRequired { pricing_url } = &self {
            return (
                StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": "licence_required",
                    "message": "This needs the space to hold a licence.",
                    "pricing_url": pricing_url,
                })),
            )
                .into_response();
        }
        if let ApiError::SeatsFull { seats, pricing_url } = &self {
            return (
                StatusCode::PAYMENT_REQUIRED,
                Json(SeatsFullBody {
                    error: "seats_full",
                    message: "Every seat of this space's licence is taken.",
                    seats: *seats,
                    pricing_url,
                }),
            )
                .into_response();
        }
        let (status, error, message) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found", "Resource not found."),
            ApiError::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "You do not have access to this resource.",
            ),
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", *message),
            ApiError::BadRequestOwned(ref message) => {
                (StatusCode::BAD_REQUEST, "bad_request", message.as_str())
            }
            ApiError::Conflict(message) => (StatusCode::CONFLICT, "conflict", *message),
            ApiError::LicenceFrozen => (
                StatusCode::CONFLICT,
                "licence_frozen",
                "This space's licence has expired: what it configured keeps applying, and can no longer be changed.",
            ),
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Authentication required.",
            ),
            ApiError::Internal
            | ApiError::SeatsFull { .. }
            | ApiError::ForbiddenBecause(_)
            | ApiError::BadRequestCode { .. }
            | ApiError::ConflictCode { .. }
            | ApiError::LicenceRequired { .. } => (
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
