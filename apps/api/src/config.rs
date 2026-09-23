//! Runtime configuration, read from environment variables.
//!
//! Every value has a sensible local-development default so `cargo run` works out of
//! the box. In containers and production, values are injected through the environment
//! (see `.env.example` and `docker-compose.yml`). No secret is ever hard-coded.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// Fully resolved server configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Socket the HTTP/TLS server binds to.
    pub addr: SocketAddr,
    /// Directory holding the static web bundle (Next.js export output) to serve.
    pub web_dist: PathBuf,
    /// Optional directory holding the self-hosted emoji pack (Fluent assets), served under
    /// `/emoji`. When unset or absent, the client falls back to native OS emoji. The pack is a
    /// deployment choice kept out of the web bundle because it can be large.
    pub emoji_dir: Option<PathBuf>,
    /// Directory an administrator may import an archive from, for the ones too large to upload.
    ///
    /// Unset means the server-side path is closed and only uploads are accepted. Nothing outside
    /// this directory is ever read: an administrator is trusted with the instance, not handed a
    /// way to have the API open any file on the machine and report what it found.
    pub import_dir: Option<PathBuf>,
    /// Optional TLS material. When both are set (and the `tls` feature is built in),
    /// the server serves HTTPS; otherwise it serves plain HTTP (local dev only).
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    /// PostgreSQL connection URL (source of truth). Dev connects in plaintext over the trusted
    /// Docker network; TLS-to-database is a later hardening concern.
    pub database_url: String,
    /// Maximum size of the PostgreSQL connection pool.
    pub db_max_connections: u32,
    /// Valkey (RESP) connection URL, used for opaque sessions and, later, pub-sub / presence.
    pub valkey_url: String,
    /// Size of the Valkey connection pool.
    pub valkey_pool_size: usize,
    /// Whether the API applies pending migrations automatically on startup. True in dev; set
    /// `RUCHOIR_AUTO_MIGRATE=false` in production and apply them through the `migrate` subcommand.
    pub auto_migrate: bool,
    /// argon2id memory cost in KiB.
    pub argon2_memory_kib: u32,
    /// argon2id iterations (time cost).
    pub argon2_iterations: u32,
    /// argon2id degree of parallelism.
    pub argon2_parallelism: u32,
    /// Sliding session idle timeout, in seconds: a session expires if unused for this long.
    pub session_idle_ttl_secs: i64,
    /// Absolute session lifetime cap, in seconds, regardless of activity.
    pub session_absolute_ttl_secs: i64,
    /// Failed logins for one account within the window before it enters a cooldown.
    pub login_max_failures: u32,
    /// Rolling window, in seconds, over which failed logins are counted.
    pub login_failure_window_secs: i64,
    /// Base cooldown, in seconds, applied on the first lockout. Doubles on repeat lockouts.
    pub login_lock_base_secs: i64,
    /// Maximum cooldown, in seconds, the progressive backoff can reach.
    pub login_lock_max_secs: i64,
    /// Per-IP rate limit on the auth routes: burst capacity (requests allowed to arrive at once).
    pub auth_rate_burst: u32,
    /// Per-IP rate limit on the auth routes: interval, in ms, after which one request is replenished.
    pub auth_rate_period_ms: u64,
    /// SMTP relay host for outgoing email. When unset, email is logged for local dev instead of sent.
    pub smtp_host: Option<String>,
    /// SMTP relay port (STARTTLS submission is 587 by default).
    pub smtp_port: u16,
    /// Optional SMTP username / password for authenticated relays.
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    /// `From` mailbox for outgoing email, e.g. `Ruchoir <no-reply@example.org>`.
    pub smtp_from: String,
    /// Talk to the relay without TLS (`RUCHOIR_SMTP_TLS=none`). For a mail catcher in development
    /// only: refused at startup unless the relay is this machine or an internal, single-label name
    /// (a Compose service), so it can never be pointed at a relay across a network.
    pub smtp_plaintext: bool,
    /// Public base URL used to build verification / reset links in emails.
    pub public_base_url: String,
    /// Lifetime, in seconds, of an email-verification token.
    pub email_verification_ttl_secs: i64,
    /// Lifetime, in seconds, of a password-reset token.
    pub password_reset_ttl_secs: i64,
    /// Path to the breached-password bloom filter. When unset, the breach check is disabled.
    pub breached_pw_bloom_path: Option<PathBuf>,
    /// WebAuthn relying-party id (registrable domain, e.g. `localhost` or `ruchoir.example.org`).
    pub webauthn_rp_id: String,
    /// WebAuthn relying-party origin (full URL the browser sees, e.g. `https://ruchoir.example.org`).
    pub webauthn_origin: String,
    /// Whether the Google OIDC connector is enabled (off by default; the flow is not implemented yet).
    pub oidc_google_enabled: bool,
    /// Whether the Microsoft OIDC connector is enabled (off by default; not implemented yet).
    pub oidc_microsoft_enabled: bool,
    /// Time-to-live, in seconds, of a live-presence heartbeat in Valkey. A connection refreshes its
    /// heartbeat within this window; once it lapses the user is considered offline.
    pub presence_ttl_secs: i64,
    /// Interval, in seconds, at which a realtime connection is expected to refresh its heartbeat.
    /// Kept comfortably below `presence_ttl_secs` so a single missed beat does not flip presence.
    pub presence_heartbeat_secs: i64,
    /// Minimum interval, in ms, between two accepted typing signals from one user in one
    /// conversation. A coarse anti-spam floor: signals arriving faster are dropped server-side.
    pub typing_min_interval_ms: i64,
    /// Capacity of the per-connection outbound event buffer. When a slow client fills it, the
    /// oldest events are dropped rather than blocking the fan-out (the client resyncs over REST).
    pub realtime_send_buffer: usize,
    /// S3 endpoint of the object store (Garage by default). Dev uses plaintext HTTP over the trusted
    /// Docker network, like PostgreSQL/Valkey; TLS-to-store is later hardening.
    pub s3_endpoint: String,
    /// S3 region label. Garage accepts any value; it is part of the request signature.
    pub s3_region: String,
    /// Bucket that holds every space's file objects.
    pub s3_bucket: String,
    /// S3 access key. When unset (with the secret), object storage is disabled and byte endpoints
    /// return 503 while file metadata keeps working (mirrors the optional mailer/breach filter).
    pub s3_access_key: Option<String>,
    /// S3 secret key. See [`Config::s3_access_key`].
    pub s3_secret_key: Option<String>,
    /// Maximum accepted upload size, in bytes. Uploads above this are rejected with 413.
    pub upload_max_bytes: u64,
    /// Longest edge, in pixels, of a generated image thumbnail (aspect ratio preserved).
    pub thumbnail_max_px: u32,
}

impl Config {
    /// Build the configuration from the process environment, applying defaults.
    pub fn from_env() -> Result<Self, ConfigError> {
        let host: IpAddr = env_or("RUCHOIR_API_HOST", "0.0.0.0")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_API_HOST"))?;
        let port: u16 = env_or("RUCHOIR_API_PORT", "8080")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_API_PORT"))?;

        let web_dist = PathBuf::from(env_or("RUCHOIR_WEB_DIST", "./apps/web/out"));
        let emoji_dir = env_opt("RUCHOIR_EMOJI_DIR").map(PathBuf::from);
        let import_dir = env_opt("RUCHOIR_IMPORT_DIR").map(PathBuf::from);

        let tls_cert = env_opt("RUCHOIR_TLS_CERT").map(PathBuf::from);
        let tls_key = env_opt("RUCHOIR_TLS_KEY").map(PathBuf::from);

        let database_url = env_or(
            "DATABASE_URL",
            "postgres://ruchoir:ruchoir@localhost:5432/ruchoir",
        );
        let db_max_connections: u32 = env_or("RUCHOIR_DB_MAX_CONNECTIONS", "10")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_DB_MAX_CONNECTIONS"))?;
        let valkey_url = env_or("VALKEY_URL", "redis://localhost:6379");
        let valkey_pool_size: usize = env_or("RUCHOIR_VALKEY_POOL_SIZE", "6")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_VALKEY_POOL_SIZE"))?;
        let auto_migrate: bool = env_or("RUCHOIR_AUTO_MIGRATE", "true")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_AUTO_MIGRATE"))?;

        // argon2id cost parameters, OWASP-aligned baseline (19 MiB, t=2, p=1). Tunable so the
        // cost can be raised on stronger hardware without a code change.
        let argon2_memory_kib: u32 = env_or("RUCHOIR_ARGON2_MEMORY_KIB", "19456")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_ARGON2_MEMORY_KIB"))?;
        let argon2_iterations: u32 = env_or("RUCHOIR_ARGON2_ITERATIONS", "2")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_ARGON2_ITERATIONS"))?;
        let argon2_parallelism: u32 = env_or("RUCHOIR_ARGON2_PARALLELISM", "1")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_ARGON2_PARALLELISM"))?;

        // Session lifetimes: sliding idle timeout (14 days) plus an absolute cap (30 days).
        let session_idle_ttl_secs: i64 = env_or("RUCHOIR_SESSION_IDLE_TTL_SECS", "1209600")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_SESSION_IDLE_TTL_SECS"))?;
        let session_absolute_ttl_secs: i64 = env_or("RUCHOIR_SESSION_ABSOLUTE_TTL_SECS", "2592000")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_SESSION_ABSOLUTE_TTL_SECS"))?;

        // Anti-bruteforce: lock an account after too many failed logins in a rolling window, with
        // a progressive (doubling) cooldown capped at a maximum.
        let login_max_failures: u32 = env_or("RUCHOIR_LOGIN_MAX_FAILURES", "5")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_LOGIN_MAX_FAILURES"))?;
        let login_failure_window_secs: i64 = env_or("RUCHOIR_LOGIN_FAILURE_WINDOW_SECS", "900")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_LOGIN_FAILURE_WINDOW_SECS"))?;
        let login_lock_base_secs: i64 = env_or("RUCHOIR_LOGIN_LOCK_BASE_SECS", "900")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_LOGIN_LOCK_BASE_SECS"))?;
        let login_lock_max_secs: i64 = env_or("RUCHOIR_LOGIN_LOCK_MAX_SECS", "86400")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_LOGIN_LOCK_MAX_SECS"))?;

        // Coarse per-IP rate limit on the auth surface (backstop above the per-account lockout).
        let auth_rate_burst: u32 = env_or("RUCHOIR_AUTH_RATE_BURST", "20")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_AUTH_RATE_BURST"))?;
        let auth_rate_period_ms: u64 = env_or("RUCHOIR_AUTH_RATE_PERIOD_MS", "500")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_AUTH_RATE_PERIOD_MS"))?;

        // Email. When SMTP_HOST is unset, the mailer logs messages for local dev instead of sending.
        let smtp_host = env_opt("RUCHOIR_SMTP_HOST");
        let smtp_port: u16 = env_or("RUCHOIR_SMTP_PORT", "587")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_SMTP_PORT"))?;
        let smtp_username = env_opt("RUCHOIR_SMTP_USERNAME");
        let smtp_password = env_opt("RUCHOIR_SMTP_PASSWORD");
        let smtp_from = env_or("RUCHOIR_SMTP_FROM", "Ruchoir <no-reply@localhost>");
        let smtp_plaintext = match env_or("RUCHOIR_SMTP_TLS", "auto").as_str() {
            "auto" => false,
            "none" => true,
            _ => return Err(ConfigError::Invalid("RUCHOIR_SMTP_TLS")),
        };
        if smtp_plaintext
            && !smtp_host
                .as_deref()
                .is_some_and(crate::auth::mailer::is_local_relay)
        {
            return Err(ConfigError::Invalid(
                "RUCHOIR_SMTP_TLS (none is only for a relay on this machine or an internal name)",
            ));
        }
        let public_base_url = env_or("RUCHOIR_PUBLIC_BASE_URL", "http://localhost:8080");
        let email_verification_ttl_secs: i64 =
            env_or("RUCHOIR_EMAIL_VERIFICATION_TTL_SECS", "86400")
                .parse()
                .map_err(|_| ConfigError::Invalid("RUCHOIR_EMAIL_VERIFICATION_TTL_SECS"))?;
        let password_reset_ttl_secs: i64 = env_or("RUCHOIR_PASSWORD_RESET_TTL_SECS", "3600")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_PASSWORD_RESET_TTL_SECS"))?;

        let breached_pw_bloom_path = env_opt("RUCHOIR_BREACHED_PW_BLOOM").map(PathBuf::from);

        // WebAuthn relying party. Origin defaults to the public base URL; rp_id to its host.
        let webauthn_rp_id = env_or("RUCHOIR_WEBAUTHN_RP_ID", "localhost");
        let webauthn_origin = env_or("RUCHOIR_WEBAUTHN_ORIGIN", &public_base_url);

        // OIDC connectors: scaffolded but off by default; the authorization-code flow is deferred.
        let oidc_google_enabled: bool = env_or("RUCHOIR_OIDC_GOOGLE_ENABLED", "false")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_OIDC_GOOGLE_ENABLED"))?;
        let oidc_microsoft_enabled: bool = env_or("RUCHOIR_OIDC_MICROSOFT_ENABLED", "false")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_OIDC_MICROSOFT_ENABLED"))?;

        // Real-time presence and typing tuning. Presence uses a heartbeat every ~20 s against a
        // 45 s TTL, so one missed beat does not flip a user offline. Typing is throttled to at most
        // one signal every 2 s per conversation, and each connection buffers up to 256 pending
        // events before shedding the oldest.
        let presence_ttl_secs: i64 = env_or("RUCHOIR_PRESENCE_TTL_SECS", "45")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_PRESENCE_TTL_SECS"))?;
        let presence_heartbeat_secs: i64 = env_or("RUCHOIR_PRESENCE_HEARTBEAT_SECS", "20")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_PRESENCE_HEARTBEAT_SECS"))?;
        let typing_min_interval_ms: i64 = env_or("RUCHOIR_TYPING_MIN_INTERVAL_MS", "2000")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_TYPING_MIN_INTERVAL_MS"))?;
        let realtime_send_buffer: usize = env_or("RUCHOIR_REALTIME_SEND_BUFFER", "256")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_REALTIME_SEND_BUFFER"))?;

        // Object store (Garage by default). Endpoint/region/bucket have dev defaults so `cargo run`
        // works against a local Garage; credentials have no default (a secret is never hard-coded),
        // and when they are unset object storage is simply disabled.
        let s3_endpoint = env_or("S3_ENDPOINT", "http://localhost:3900");
        let s3_region = env_or("S3_REGION", "garage");
        let s3_bucket = env_or("S3_BUCKET", "ruchoir");
        let s3_access_key = env_opt("S3_ACCESS_KEY_ID");
        let s3_secret_key = env_opt("S3_SECRET_ACCESS_KEY");
        // Default cap: 100 MiB per upload.
        let upload_max_bytes: u64 = env_or("RUCHOIR_UPLOAD_MAX_BYTES", "104857600")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_UPLOAD_MAX_BYTES"))?;
        let thumbnail_max_px: u32 = env_or("RUCHOIR_THUMBNAIL_MAX_PX", "512")
            .parse()
            .map_err(|_| ConfigError::Invalid("RUCHOIR_THUMBNAIL_MAX_PX"))?;

        Ok(Self {
            addr: SocketAddr::new(host, port),
            web_dist,
            emoji_dir,
            import_dir,
            tls_cert,
            tls_key,
            database_url,
            db_max_connections,
            valkey_url,
            valkey_pool_size,
            auto_migrate,
            argon2_memory_kib,
            argon2_iterations,
            argon2_parallelism,
            session_idle_ttl_secs,
            session_absolute_ttl_secs,
            login_max_failures,
            login_failure_window_secs,
            login_lock_base_secs,
            login_lock_max_secs,
            auth_rate_burst,
            auth_rate_period_ms,
            smtp_host,
            smtp_port,
            smtp_username,
            smtp_password,
            smtp_from,
            smtp_plaintext,
            public_base_url,
            email_verification_ttl_secs,
            password_reset_ttl_secs,
            breached_pw_bloom_path,
            webauthn_rp_id,
            webauthn_origin,
            oidc_google_enabled,
            oidc_microsoft_enabled,
            presence_ttl_secs,
            presence_heartbeat_secs,
            typing_min_interval_ms,
            realtime_send_buffer,
            s3_endpoint,
            s3_region,
            s3_bucket,
            s3_access_key,
            s3_secret_key,
            upload_max_bytes,
            thumbnail_max_px,
        })
    }

    /// Whether object-store credentials are configured. When false, byte endpoints return 503 and
    /// file metadata (the tree) keeps working.
    pub fn s3_enabled(&self) -> bool {
        self.s3_access_key.is_some() && self.s3_secret_key.is_some()
    }

    /// Whether TLS material is configured. Actual TLS serving also requires the
    /// `tls` build feature.
    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }
}

/// Read an environment variable or fall back to a default.
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Read an environment variable, treating empty strings as unset.
fn env_opt(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// Configuration errors surfaced at startup.
#[derive(Debug)]
pub enum ConfigError {
    /// A variable was present but could not be parsed.
    Invalid(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Invalid(key) => write!(f, "invalid value for {key}"),
        }
    }
}

impl std::error::Error for ConfigError {}
