//! Authentication endpoints: register, login, logout, log-out-everywhere, the current-session
//! ("me") endpoint, email verification and password reset.
//!
//! The API owns auth end to end. MFA step-up (TOTP, passkeys) lands in a later step; the shapes
//! here are the contract the web client calls.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use super::cookie::{clear_session_cookie, session_cookie, SESSION_COOKIE};
use super::error::AuthError;
use super::extract::AuthSession;
use super::tokens::{self, TokenPurpose};
use super::{crypto, mfa, passkey, password, recovery, session, throttle, totp};
use crate::entities::{recovery_codes, totp_secrets, users, webauthn_credentials};
use crate::state::AppState;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse,
};

/// New-account request.
#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterRequest {
    pub email: String,
    pub display_name: String,
    pub password: String,
}

/// Credentials for an existing account.
#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// A request that carries only an email address (verification resend, reset request).
#[derive(Debug, Deserialize, ToSchema)]
pub struct EmailRequest {
    pub email: String,
}

/// Confirm an email-verification token.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TokenRequest {
    pub token: String,
}

/// Set a new password using a reset token.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PasswordResetConfirm {
    pub token: String,
    pub password: String,
}

/// TOTP enrollment material returned to the client to display.
#[derive(Debug, Serialize, ToSchema)]
pub struct TotpEnrollResponse {
    /// The `otpauth://` provisioning URI for manual entry.
    pub otpauth_url: String,
    /// An SVG QR code encoding the provisioning URI, ready to embed.
    pub qr_svg: String,
}

/// A TOTP code submitted to confirm enrollment.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TotpConfirm {
    pub code: String,
}

/// A freshly generated set of recovery codes, shown to the user exactly once.
#[derive(Debug, Serialize, ToSchema)]
pub struct RecoveryCodesResponse {
    pub codes: Vec<String>,
}

/// Returned by login when the account requires a second factor. The client completes one of the
/// listed methods against `mfa_token` to obtain a session.
#[derive(Debug, Serialize, ToSchema)]
pub struct MfaRequired {
    pub mfa_required: bool,
    pub methods: Vec<String>,
    pub mfa_token: String,
}

/// A second factor submitted with its pending MFA token (TOTP or recovery code).
#[derive(Debug, Deserialize, ToSchema)]
pub struct MfaCodeRequest {
    pub mfa_token: String,
    pub code: String,
}

/// Which optional OIDC connectors are enabled.
#[derive(Debug, Serialize, ToSchema)]
pub struct OidcProviders {
    pub google: bool,
    pub microsoft: bool,
}

/// Start a passkey authentication for a pending MFA step-up.
#[derive(Debug, Deserialize)]
pub struct PasskeyAuthStart {
    pub mfa_token: String,
}

/// Finish a passkey authentication for a pending MFA step-up.
#[derive(Debug, Deserialize)]
pub struct PasskeyAuthFinish {
    pub mfa_token: String,
    pub credential: PublicKeyCredential,
}

/// Public view of an account returned to the client. Never includes secrets.
#[derive(Debug, Serialize, ToSchema)]
pub struct UserSummary {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
}

impl From<users::Model> for UserSummary {
    fn from(model: users::Model) -> Self {
        Self {
            id: model.id,
            email: model.email,
            display_name: model.display_name,
        }
    }
}

/// Build the auth sub-router. Mounted under `/api/v1/auth` by the main router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/logout/all", post(logout_all))
        .route("/session", get(current_session))
        .route("/verify-email/request", post(verify_email_request))
        .route("/verify-email/confirm", post(verify_email_confirm))
        .route("/password-reset/request", post(password_reset_request))
        .route("/password-reset/confirm", post(password_reset_confirm))
        .route("/mfa/totp/enroll", post(totp_enroll))
        .route("/mfa/totp/confirm", post(totp_confirm))
        .route("/mfa/recovery-codes/generate", post(recovery_generate))
        .route("/mfa/passkey/register/start", post(passkey_register_start))
        .route(
            "/mfa/passkey/register/finish",
            post(passkey_register_finish),
        )
        .route("/mfa/totp/verify", post(totp_verify))
        .route("/mfa/recovery/verify", post(recovery_verify))
        .route(
            "/mfa/passkey/authenticate/start",
            post(passkey_authenticate_start),
        )
        .route(
            "/mfa/passkey/authenticate/finish",
            post(passkey_authenticate_finish),
        )
        .route("/oidc/providers", get(oidc_providers))
        .route("/oidc/{provider}/start", get(oidc_not_implemented))
        .route("/oidc/{provider}/callback", get(oidc_not_implemented))
}

/// Register a new account. The account starts unverified; a verification email is sent and no
/// session is opened until the address is confirmed.
#[utoipa::path(
    post,
    path = "/api/v1/auth/register",
    tag = "auth",
    request_body = RegisterRequest,
    responses(
        (status = 201, description = "Account created, verification email sent", body = UserSummary),
        (status = 409, description = "Email already registered"),
        (status = 422, description = "Password does not meet requirements")
    )
)]
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<UserSummary>), AuthError> {
    let email = body.email.trim().to_lowercase();
    let display_name = body.display_name.trim().to_string();
    if email.is_empty() || display_name.is_empty() {
        return Err(AuthError::WeakPassword);
    }
    password::check_policy(&body.password, &state.breaches)?;

    let existing = users::Entity::find()
        .filter(users::Column::Email.eq(email.clone()))
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    if existing.is_some() {
        return Err(AuthError::EmailTaken);
    }

    let password_hash = password::hash_password(&state.config, &body.password)?;
    let user_id = Uuid::new_v4();
    let model = users::ActiveModel {
        id: Set(user_id),
        email: Set(email.clone()),
        display_name: Set(display_name),
        password_hash: Set(Some(password_hash)),
        status: Set("pending".to_string()),
        mfa_enforced: Set(false),
        // Profile fields: unset at registration, filled in later via profile editing.
        title: NotSet,
        pronouns: NotSet,
        timezone: NotSet,
        bio: NotSet,
        avatar_key: NotSet,
        is_bot: NotSet,
        // Presence override starts unset (automatic); the user sets it later from the account menu.
        manual_presence: NotSet,
        created_at: NotSet,
        updated_at: NotSet,
    }
    .insert(&state.db)
    .await
    .map_err(|_| AuthError::Internal)?;

    send_verification_email(&state, user_id, &email).await?;

    Ok((StatusCode::CREATED, Json(model.into())))
}

/// Verify credentials and, on success for a verified account, open a session.
#[utoipa::path(
    post,
    path = "/api/v1/auth/login",
    tag = "auth",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Authenticated", body = UserSummary),
        (status = 401, description = "Invalid credentials"),
        (status = 403, description = "Account locked or email not verified"),
        (status = 429, description = "Too many attempts")
    )
)]
pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> Result<Response, AuthError> {
    let email = body.email.trim().to_lowercase();

    // Refuse early if this account is in an anti-bruteforce cooldown. Keyed by the submitted email
    // whether or not it exists, so the response never reveals account existence.
    if throttle::is_locked(&state.valkey, &email).await? {
        return Err(AuthError::TooManyAttempts);
    }

    let user = users::Entity::find()
        .filter(users::Column::Email.eq(email.clone()))
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    // Admin-locked accounts are refused outright (distinct from a bruteforce cooldown).
    if let Some(ref u) = user {
        if u.status == "locked" {
            return Err(AuthError::AccountLocked);
        }
    }

    // Verify uniformly whether or not the account exists.
    let authenticated = match &user {
        Some(u) => u
            .password_hash
            .as_deref()
            .is_some_and(|phc| password::verify_password(&state.config, &body.password, phc)),
        None => false,
    };

    if !authenticated {
        throttle::record_failure(&state.valkey, &state.config, &email).await?;
        return Err(AuthError::InvalidCredentials);
    }
    throttle::record_success(&state.valkey, &email).await?;

    let user = user.expect("authenticated implies a present user");
    // Only a verified account may open a session (revealed only after a correct password).
    if user.status == "pending" {
        return Err(AuthError::EmailNotVerified);
    }

    // MFA step-up: an enforced account completes a second factor before any session is issued.
    if user.mfa_enforced {
        let methods = available_methods(&state, user.id).await?;
        let mfa_token = mfa::start_pending(&state.valkey, user.id).await?;
        return Ok(Json(MfaRequired {
            mfa_required: true,
            methods,
            mfa_token,
        })
        .into_response());
    }

    let session_id = session::create(&state.valkey, &state.config, user.id).await?;
    let jar = jar.add(session_cookie(
        session_id,
        state.config.session_idle_ttl_secs,
    ));
    Ok((jar, Json(UserSummary::from(user))).into_response())
}

/// Revoke the current session and clear the cookie.
#[utoipa::path(
    post,
    path = "/api/v1/auth/logout",
    tag = "auth",
    responses((status = 204, description = "Session revoked"))
)]
pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(StatusCode, CookieJar), AuthError> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        session::delete(&state.valkey, cookie.value()).await?;
    }
    Ok((StatusCode::NO_CONTENT, jar.add(clear_session_cookie())))
}

/// Return the currently authenticated identity (the "me" endpoint). The `AuthSession` extractor
/// enforces a valid session; an anonymous request never reaches the body and gets a 401.
#[utoipa::path(
    get,
    path = "/api/v1/auth/session",
    tag = "auth",
    responses(
        (status = 200, description = "Current identity", body = UserSummary),
        (status = 401, description = "Not authenticated")
    )
)]
pub async fn current_session(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<UserSummary>, AuthError> {
    let user = users::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;
    Ok(Json(user.into()))
}

/// Revoke every session of the current user, then clear the cookie.
#[utoipa::path(
    post,
    path = "/api/v1/auth/logout/all",
    tag = "auth",
    responses((status = 204, description = "All sessions revoked"))
)]
pub async fn logout_all(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(StatusCode, CookieJar), AuthError> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        if let Some(record) = session::get(&state.valkey, cookie.value()).await? {
            session::delete_all(&state.valkey, record.user_id).await?;
        }
    }
    Ok((StatusCode::NO_CONTENT, jar.add(clear_session_cookie())))
}

/// Resend an email-verification link. Always responds `204`, whether or not the address exists or
/// is still pending, so it never reveals account state.
#[utoipa::path(
    post,
    path = "/api/v1/auth/verify-email/request",
    tag = "auth",
    request_body = EmailRequest,
    responses((status = 204, description = "Verification email sent if applicable"))
)]
pub async fn verify_email_request(
    State(state): State<AppState>,
    Json(body): Json<EmailRequest>,
) -> Result<StatusCode, AuthError> {
    let email = body.email.trim().to_lowercase();
    if let Some(user) = users::Entity::find()
        .filter(users::Column::Email.eq(email.clone()))
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
    {
        if user.status == "pending" {
            send_verification_email(&state, user.id, &email).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Confirm an email address with a verification token, activating the account.
#[utoipa::path(
    post,
    path = "/api/v1/auth/verify-email/confirm",
    tag = "auth",
    request_body = TokenRequest,
    responses(
        (status = 204, description = "Email verified"),
        (status = 400, description = "Invalid or expired token")
    )
)]
pub async fn verify_email_confirm(
    State(state): State<AppState>,
    Json(body): Json<TokenRequest>,
) -> Result<StatusCode, AuthError> {
    let user_id = tokens::consume(&state.valkey, TokenPurpose::VerifyEmail, &body.token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::InvalidToken)?;

    let mut active = user.into_active_model();
    active.status = Set("active".to_string());
    active.updated_at = Set(OffsetDateTime::now_utc());
    active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Request a password reset. Always responds `204`, whether or not the address exists, so it never
/// reveals account existence.
#[utoipa::path(
    post,
    path = "/api/v1/auth/password-reset/request",
    tag = "auth",
    request_body = EmailRequest,
    responses((status = 204, description = "Reset email sent if applicable"))
)]
pub async fn password_reset_request(
    State(state): State<AppState>,
    Json(body): Json<EmailRequest>,
) -> Result<StatusCode, AuthError> {
    let email = body.email.trim().to_lowercase();
    if let Some(user) = users::Entity::find()
        .filter(users::Column::Email.eq(email.clone()))
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
    {
        // Only password accounts can reset a password.
        if user.password_hash.is_some() {
            send_reset_email(&state, user.id, &email).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Set a new password from a reset token and revoke all existing sessions of that user.
#[utoipa::path(
    post,
    path = "/api/v1/auth/password-reset/confirm",
    tag = "auth",
    request_body = PasswordResetConfirm,
    responses(
        (status = 204, description = "Password changed"),
        (status = 400, description = "Invalid or expired token"),
        (status = 422, description = "Password does not meet requirements")
    )
)]
pub async fn password_reset_confirm(
    State(state): State<AppState>,
    Json(body): Json<PasswordResetConfirm>,
) -> Result<StatusCode, AuthError> {
    // Validate the new password before spending the token.
    password::check_policy(&body.password, &state.breaches)?;

    let user_id = tokens::consume(&state.valkey, TokenPurpose::PasswordReset, &body.token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::InvalidToken)?;

    let new_hash = password::hash_password(&state.config, &body.password)?;
    let mut active = user.into_active_model();
    active.password_hash = Set(Some(new_hash));
    active.updated_at = Set(OffsetDateTime::now_utc());
    active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    // A password change invalidates every existing session.
    session::delete_all(&state.valkey, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Begin TOTP enrollment: generate a secret, store it encrypted (unconfirmed), and return the
/// provisioning URI plus a QR code. Enrollment is finalized by `totp_confirm`.
#[utoipa::path(
    post,
    path = "/api/v1/auth/mfa/totp/enroll",
    tag = "auth",
    responses(
        (status = 200, description = "Enrollment started", body = TotpEnrollResponse),
        (status = 401, description = "Not authenticated")
    )
)]
pub async fn totp_enroll(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<TotpEnrollResponse>, AuthError> {
    let user = users::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;

    let secret = totp::generate_secret()?;
    let (ciphertext, nonce) = crypto::encrypt(&state.secret_key, &secret)?;

    // Replace any prior (possibly unconfirmed) enrollment.
    totp_secrets::Entity::delete_by_id(auth.user_id)
        .exec(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    totp_secrets::ActiveModel {
        user_id: Set(auth.user_id),
        secret_ciphertext: Set(ciphertext),
        secret_nonce: Set(nonce),
        confirmed_at: Set(None),
        created_at: NotSet,
        updated_at: NotSet,
    }
    .insert(&state.db)
    .await
    .map_err(|_| AuthError::Internal)?;

    let totp = totp::build(&secret, &user.email)?;
    let otpauth_url = totp.to_url().map_err(|_| AuthError::Internal)?;
    let qr = qrcodegen::QrCode::encode_text(&otpauth_url, qrcodegen::QrCodeEcc::Medium)
        .map_err(|_| AuthError::Internal)?;
    let qr_svg = qr_to_svg(&qr, 4);

    Ok(Json(TotpEnrollResponse {
        otpauth_url,
        qr_svg,
    }))
}

/// Finalize TOTP enrollment by verifying a code, then enforce MFA on the account.
#[utoipa::path(
    post,
    path = "/api/v1/auth/mfa/totp/confirm",
    tag = "auth",
    request_body = TotpConfirm,
    responses(
        (status = 204, description = "TOTP enabled"),
        (status = 400, description = "Incorrect code"),
        (status = 401, description = "Not authenticated")
    )
)]
pub async fn totp_confirm(
    State(state): State<AppState>,
    auth: AuthSession,
    Json(body): Json<TotpConfirm>,
) -> Result<StatusCode, AuthError> {
    let row = totp_secrets::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::InvalidCode)?;
    let user = users::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;

    let secret = crypto::decrypt(&state.secret_key, &row.secret_ciphertext, &row.secret_nonce)?;
    let totp = totp::build(&secret, &user.email)?;
    if totp.check_current(&body.code).is_none() {
        return Err(AuthError::InvalidCode);
    }

    let now = OffsetDateTime::now_utc();
    let mut secret_active = row.into_active_model();
    secret_active.confirmed_at = Set(Some(now));
    secret_active.updated_at = Set(now);
    secret_active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    let mut user_active = user.into_active_model();
    user_active.mfa_enforced = Set(true);
    user_active.updated_at = Set(now);
    user_active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// Generate a fresh set of single-use recovery codes, replacing any existing set. The plaintext
/// codes are returned exactly once; only their hashes are stored.
#[utoipa::path(
    post,
    path = "/api/v1/auth/mfa/recovery-codes/generate",
    tag = "auth",
    responses(
        (status = 200, description = "New recovery codes", body = RecoveryCodesResponse),
        (status = 401, description = "Not authenticated")
    )
)]
pub async fn recovery_generate(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<RecoveryCodesResponse>, AuthError> {
    let codes = recovery::generate_codes()?;

    // Replace any prior set.
    recovery_codes::Entity::delete_many()
        .filter(recovery_codes::Column::UserId.eq(auth.user_id))
        .exec(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    for code in &codes {
        let code_hash = recovery::hash_code(&state.secret_key, code);
        recovery_codes::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(auth.user_id),
            code_hash: Set(code_hash),
            used_at: Set(None),
            created_at: NotSet,
        }
        .insert(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    }

    Ok(Json(RecoveryCodesResponse { codes }))
}

/// Begin passkey registration: returns the WebAuthn creation challenge the browser passes to
/// `navigator.credentials.create()`. The ceremony state is kept server-side in Valkey.
///
/// Not described in the OpenAPI document: the WebAuthn request/response types are foreign and do
/// not implement utoipa's schema traits.
pub async fn passkey_register_start(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<CreationChallengeResponse>, AuthError> {
    let user = users::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;

    let (challenge, registration) = state
        .webauthn
        .start_passkey_registration(user.id, &user.email, &user.display_name, None)
        .map_err(|_| AuthError::Internal)?;

    passkey::store_registration(&state.valkey, auth.user_id, &registration).await?;

    Ok(Json(challenge))
}

/// Finish passkey registration: verify the browser's attestation, store the credential, and
/// enforce MFA on the account. Request body is the WebAuthn `RegisterPublicKeyCredential`.
///
/// Not described in the OpenAPI document: the WebAuthn request/response types are foreign and do
/// not implement utoipa's schema traits.
pub async fn passkey_register_finish(
    State(state): State<AppState>,
    auth: AuthSession,
    Json(credential): Json<RegisterPublicKeyCredential>,
) -> Result<StatusCode, AuthError> {
    let registration = passkey::take_registration(&state.valkey, auth.user_id)
        .await?
        .ok_or(AuthError::InvalidToken)?;

    let passkey = state
        .webauthn
        .finish_passkey_registration(&credential, &registration)
        .map_err(|_| AuthError::InvalidCode)?;

    let credential_id = passkey.cred_id().as_ref().to_vec();
    let passkey_blob = serde_json::to_vec(&passkey).map_err(|_| AuthError::Internal)?;

    webauthn_credentials::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(auth.user_id),
        credential_id: Set(credential_id),
        public_key: Set(passkey_blob),
        sign_count: Set(0),
        transports: Set(None),
        label: Set(None),
        created_at: NotSet,
        last_used_at: Set(None),
    }
    .insert(&state.db)
    .await
    .map_err(|_| AuthError::Internal)?;

    // Registering a passkey enforces MFA on the account.
    let user = users::Entity::find_by_id(auth.user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;
    let mut user_active = user.into_active_model();
    user_active.mfa_enforced = Set(true);
    user_active.updated_at = Set(OffsetDateTime::now_utc());
    user_active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// Complete a TOTP second factor for a pending login.
#[utoipa::path(
    post,
    path = "/api/v1/auth/mfa/totp/verify",
    tag = "auth",
    request_body = MfaCodeRequest,
    responses(
        (status = 200, description = "Authenticated", body = UserSummary),
        (status = 400, description = "Incorrect code"),
        (status = 401, description = "No pending step-up")
    )
)]
pub async fn totp_verify(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<MfaCodeRequest>,
) -> Result<Response, AuthError> {
    let user_id = mfa::resolve_pending(&state.valkey, &body.mfa_token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let row = totp_secrets::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::InvalidCode)?;
    if row.confirmed_at.is_none() {
        return Err(AuthError::InvalidCode);
    }
    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;
    let secret = crypto::decrypt(&state.secret_key, &row.secret_ciphertext, &row.secret_nonce)?;
    let totp = totp::build(&secret, &user.email)?;
    if totp.check_current(&body.code).is_none() {
        return Err(AuthError::InvalidCode);
    }
    complete_mfa_login(&state, jar, &body.mfa_token, user_id).await
}

/// Complete a login with a single-use recovery code (MFA fallback).
#[utoipa::path(
    post,
    path = "/api/v1/auth/mfa/recovery/verify",
    tag = "auth",
    request_body = MfaCodeRequest,
    responses(
        (status = 200, description = "Authenticated", body = UserSummary),
        (status = 400, description = "Incorrect code"),
        (status = 401, description = "No pending step-up")
    )
)]
pub async fn recovery_verify(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<MfaCodeRequest>,
) -> Result<Response, AuthError> {
    let user_id = mfa::resolve_pending(&state.valkey, &body.mfa_token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let hash = recovery::hash_code(&state.secret_key, &body.code);
    let row = recovery_codes::Entity::find()
        .filter(recovery_codes::Column::UserId.eq(user_id))
        .filter(recovery_codes::Column::CodeHash.eq(hash))
        .filter(recovery_codes::Column::UsedAt.is_null())
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::InvalidCode)?;
    let mut active = row.into_active_model();
    active.used_at = Set(Some(OffsetDateTime::now_utc()));
    active
        .update(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    complete_mfa_login(&state, jar, &body.mfa_token, user_id).await
}

/// Begin passkey authentication for a pending MFA step-up.
///
/// Not described in the OpenAPI document: the WebAuthn request/response types are foreign.
pub async fn passkey_authenticate_start(
    State(state): State<AppState>,
    Json(body): Json<PasskeyAuthStart>,
) -> Result<Json<RequestChallengeResponse>, AuthError> {
    let user_id = mfa::resolve_pending(&state.valkey, &body.mfa_token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let passkeys = load_passkeys(&state, user_id).await?;
    if passkeys.is_empty() {
        return Err(AuthError::InvalidCode);
    }
    let (challenge, auth_state) = state
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|_| AuthError::Internal)?;
    passkey::store_authentication(&state.valkey, &body.mfa_token, &auth_state).await?;
    Ok(Json(challenge))
}

/// Finish passkey authentication and, on success, open a session.
///
/// Not described in the OpenAPI document: the WebAuthn request/response types are foreign. The
/// signature counter is not yet persisted back (a hardening follow-up); the single-use challenge
/// still prevents assertion replay.
pub async fn passkey_authenticate_finish(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<PasskeyAuthFinish>,
) -> Result<Response, AuthError> {
    let user_id = mfa::resolve_pending(&state.valkey, &body.mfa_token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    let auth_state = passkey::take_authentication(&state.valkey, &body.mfa_token)
        .await?
        .ok_or(AuthError::InvalidToken)?;
    state
        .webauthn
        .finish_passkey_authentication(&body.credential, &auth_state)
        .map_err(|_| AuthError::InvalidCode)?;
    complete_mfa_login(&state, jar, &body.mfa_token, user_id).await
}

/// Complete a login after a successful second factor: consume the pending token, open a session.
async fn complete_mfa_login(
    state: &AppState,
    jar: CookieJar,
    mfa_token: &str,
    user_id: Uuid,
) -> Result<Response, AuthError> {
    mfa::consume_pending(&state.valkey, mfa_token).await?;
    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .ok_or(AuthError::Unauthorized)?;
    let session_id = session::create(&state.valkey, &state.config, user_id).await?;
    let jar = jar.add(session_cookie(
        session_id,
        state.config.session_idle_ttl_secs,
    ));
    Ok((jar, Json(UserSummary::from(user))).into_response())
}

/// The second-factor methods a user currently has available.
async fn available_methods(state: &AppState, user_id: Uuid) -> Result<Vec<String>, AuthError> {
    let mut methods = Vec::new();
    let totp = totp_secrets::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    if totp.is_some_and(|t| t.confirmed_at.is_some()) {
        methods.push("totp".to_string());
    }
    let has_passkey = webauthn_credentials::Entity::find()
        .filter(webauthn_credentials::Column::UserId.eq(user_id))
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .is_some();
    if has_passkey {
        methods.push("passkey".to_string());
    }
    let has_recovery = recovery_codes::Entity::find()
        .filter(recovery_codes::Column::UserId.eq(user_id))
        .filter(recovery_codes::Column::UsedAt.is_null())
        .one(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?
        .is_some();
    if has_recovery {
        methods.push("recovery".to_string());
    }
    Ok(methods)
}

/// Load and deserialize a user's registered passkeys.
async fn load_passkeys(state: &AppState, user_id: Uuid) -> Result<Vec<Passkey>, AuthError> {
    let rows = webauthn_credentials::Entity::find()
        .filter(webauthn_credentials::Column::UserId.eq(user_id))
        .all(&state.db)
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|row| serde_json::from_slice::<Passkey>(&row.public_key).ok())
        .collect())
}

/// Report which OIDC connectors are enabled, so the client can show the right sign-in buttons.
#[utoipa::path(
    get,
    path = "/api/v1/auth/oidc/providers",
    tag = "auth",
    responses((status = 200, description = "Enabled OIDC connectors", body = OidcProviders))
)]
pub async fn oidc_providers(State(state): State<AppState>) -> Json<OidcProviders> {
    Json(OidcProviders {
        google: state.config.oidc_google_enabled,
        microsoft: state.config.oidc_microsoft_enabled,
    })
}

/// OIDC sign-in scaffold: the connectors are off by default and the authorization-code flow is
/// deferred, so these endpoints reply `501`. (Not described in the OpenAPI document.)
async fn oidc_not_implemented() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "oidc_not_implemented",
            "message": "OIDC sign-in is not available yet."
        })),
    )
        .into_response()
}

/// Render a QR code as a self-contained SVG string (no external assets, embeddable directly).
fn qr_to_svg(qr: &qrcodegen::QrCode, border: i32) -> String {
    use std::fmt::Write as _;
    let size = qr.size();
    let dim = size + border * 2;
    let mut svg = String::new();
    let _ = write!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" stroke=\"none\">\
         <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/><path d=\""
    );
    for y in 0..size {
        for x in 0..size {
            if qr.get_module(x, y) {
                let _ = write!(svg, "M{},{}h1v1h-1z", x + border, y + border);
            }
        }
    }
    svg.push_str("\" fill=\"#000000\"/></svg>");
    svg
}

/// Issue and send an email-verification link for a user.
async fn send_verification_email(
    state: &AppState,
    user_id: Uuid,
    email: &str,
) -> Result<(), AuthError> {
    let token = tokens::issue(
        &state.valkey,
        TokenPurpose::VerifyEmail,
        user_id,
        state.config.email_verification_ttl_secs,
    )
    .await?;
    let base = state.mailer.base_url.trim_end_matches('/');
    let link = format!("{base}/verify-email?token={token}");
    let hours = state.config.email_verification_ttl_secs / 3600;
    let body = format!(
        "Welcome to Ruchoir.\n\nConfirm your email address by opening this link:\n{link}\n\n\
         The link expires in {hours} hours. If you did not create an account, ignore this message."
    );
    state
        .mailer
        .send(email, "Confirm your Ruchoir email", body)
        .await
        .map_err(|_| AuthError::Internal)
}

/// Issue and send a password-reset link for a user.
async fn send_reset_email(state: &AppState, user_id: Uuid, email: &str) -> Result<(), AuthError> {
    let token = tokens::issue(
        &state.valkey,
        TokenPurpose::PasswordReset,
        user_id,
        state.config.password_reset_ttl_secs,
    )
    .await?;
    let base = state.mailer.base_url.trim_end_matches('/');
    let link = format!("{base}/reset-password?token={token}");
    let minutes = state.config.password_reset_ttl_secs / 60;
    let body = format!(
        "A password reset was requested for your Ruchoir account.\n\nSet a new password here:\n{link}\n\n\
         The link expires in {minutes} minutes. If you did not request this, ignore this message."
    );
    state
        .mailer
        .send(email, "Reset your Ruchoir password", body)
        .await
        .map_err(|_| AuthError::Internal)
}
