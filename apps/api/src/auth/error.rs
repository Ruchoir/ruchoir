//! Authentication error type and its HTTP representation.
//!
//! Responses are deliberately terse and uniform so they never reveal whether an email is
//! registered beyond a generic conflict. Nothing sensitive is ever placed in the body.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Errors surfaced by the auth endpoints.
#[derive(Debug)]
pub enum AuthError {
    /// Registration hit an existing account (generic conflict, no enumeration).
    EmailTaken,
    /// Wrong email or password (uniform, does not distinguish the two).
    InvalidCredentials,
    /// No valid session on a protected request.
    Unauthorized,
    /// Password failed the policy (too short).
    WeakPassword,
    /// Password appears in the offline breached-password set.
    BreachedPassword,
    /// The account is locked.
    AccountLocked,
    /// Too many failed attempts: the account is in an anti-bruteforce cooldown.
    TooManyAttempts,
    /// The account exists but its email address is not yet verified.
    EmailNotVerified,
    /// A verification or password-reset token is missing, expired or already used.
    InvalidToken,
    /// An MFA verification code (e.g. TOTP) is incorrect.
    InvalidCode,
    /// A browser asked for a session token, which only a native app may hold (see
    /// [`super::session::Delivery`]).
    TokenFromBrowser,
    /// Any unexpected server-side failure. Never leaks internals to the client.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            AuthError::EmailTaken => (
                StatusCode::CONFLICT,
                "email_taken",
                "An account with this email already exists.",
            ),
            AuthError::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "Invalid email or password.",
            ),
            AuthError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Authentication required.",
            ),
            AuthError::WeakPassword => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "weak_password",
                "Password does not meet the minimum requirements.",
            ),
            AuthError::BreachedPassword => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "breached_password",
                "This password has appeared in a known data breach; choose another.",
            ),
            AuthError::AccountLocked => (
                StatusCode::FORBIDDEN,
                "account_locked",
                "This account is locked.",
            ),
            AuthError::TooManyAttempts => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_attempts",
                "Too many attempts. Try again later.",
            ),
            AuthError::EmailNotVerified => (
                StatusCode::FORBIDDEN,
                "email_not_verified",
                "Confirm your email address before signing in.",
            ),
            AuthError::InvalidToken => (
                StatusCode::BAD_REQUEST,
                "invalid_token",
                "This link is invalid or has expired.",
            ),
            AuthError::InvalidCode => (
                StatusCode::BAD_REQUEST,
                "invalid_code",
                "Incorrect verification code.",
            ),
            AuthError::TokenFromBrowser => (
                StatusCode::BAD_REQUEST,
                "token_from_browser",
                "A browser session is a cookie; tokens are for the apps.",
            ),
            AuthError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An unexpected error occurred.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}
