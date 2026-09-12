//! Authentication: password hashing, opaque sessions, the session cookie and the HTTP routes.
//!
//! The API owns auth end to end. Passwords are argon2id; sessions are opaque records in Valkey
//! delivered as a hardened `__Host-` cookie; the client never holds an auth secret. The
//! authorization guard (extracting the caller from the session on every protected request) and
//! MFA build on these pieces in later steps.

pub mod breach;
pub mod cookie;
pub mod crypto;
pub mod error;
pub mod extract;
pub mod mail_text;
pub mod mailer;
pub mod mfa;
pub mod passkey;
pub mod recovery;
pub mod routes;
pub mod session;
pub mod throttle;
pub mod tokens;
pub mod totp;

mod password;

/// Re-exported so other modules (the dev seed, the `bootstrap` subcommand) can hash a password and
/// hold it to the same policy without reaching into the private `password` submodule.
pub use password::{check_policy, hash_password};
