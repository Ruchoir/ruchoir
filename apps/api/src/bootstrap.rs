//! `ruchoir-api bootstrap`: create the first administrator of a fresh instance.
//!
//! Until this exists an installation has no way in. Registration is open, but the first account to
//! register would be an ordinary member of nothing, and the dev seed refuses to run outside
//! development on purpose, since it fabricates demo data. So a new deployment reaches a running
//! server with no one able to use it, which is where every self-hosted install would stop.
//!
//! Deliberately a subcommand rather than something the server does on its own: creating an account
//! is a decision, and a server that quietly minted an administrator from whatever was in its
//! environment would be one restart away from an unpleasant surprise. It refuses outright once any
//! account exists, so it cannot be used to slip a second one in later.
//!
//! Values come from the environment so an unattended install can script it. The password may also
//! be piped on standard input, which keeps it out of the environment and out of shell history:
//!
//! ```sh
//! RUCHOIR_ADMIN_EMAIL=admin@example.fr RUCHOIR_ADMIN_NAME="Camille Roussel" \
//!   ruchoir-api bootstrap < /path/to/password
//! ```

use std::io::{BufRead, IsTerminal};

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, TransactionTrait};
use uuid::Uuid;

use crate::auth::{breach::BreachFilter, check_policy, hash_password};
use crate::config::Config;
use crate::entities::users;
use crate::messaging::spaces::create_owned_space;

type Failure = Box<dyn std::error::Error>;

/// Create the first administrator, and optionally their first space.
pub async fn run(db: &DatabaseConnection, config: &Config) -> Result<(), Failure> {
    // One existing account is enough to say this instance is past its first run. Counting rather
    // than looking for an admin: a half-finished install with one ordinary account still must not
    // grow a second identity from the shell.
    if users::Entity::find().one(db).await?.is_some() {
        return Err(
            "refusing to bootstrap: this instance already has at least one account. \
             Use an invitation to add people."
                .into(),
        );
    }

    let email = env_value("RUCHOIR_ADMIN_EMAIL")?.trim().to_lowercase();
    if !email.contains('@') {
        return Err("RUCHOIR_ADMIN_EMAIL does not look like an address".into());
    }
    let display_name = env_value("RUCHOIR_ADMIN_NAME")?.trim().to_owned();
    if display_name.is_empty() {
        return Err("RUCHOIR_ADMIN_NAME is empty".into());
    }
    let admin_password = read_password()?;

    // The same policy the registration endpoint enforces, so the first account is not the weakest
    // one on the instance. The breach filter is loaded only when configured; without it the check
    // falls back to the length and composition rules, exactly as it does for a normal sign-up.
    let breaches = match &config.breached_pw_bloom_path {
        Some(path) => BreachFilter::from_path(path).unwrap_or_else(|_| BreachFilter::disabled()),
        None => BreachFilter::disabled(),
    };
    check_policy(&admin_password, &breaches)
        .map_err(|_| "this password is too weak, or appears in a known breach list")?;
    let password_hash =
        hash_password(config, &admin_password).map_err(|_| "could not hash the password")?;

    let user_id = Uuid::new_v4();
    let txn = db.begin().await?;
    users::ActiveModel {
        id: Set(user_id),
        email: Set(email.clone()),
        display_name: Set(display_name.clone()),
        password_hash: Set(Some(password_hash)),
        // Active, not pending: there is no one to confirm the address to, and an instance whose
        // only account cannot sign in is the situation this command exists to prevent.
        status: Set("active".to_owned()),
        mfa_enforced: Set(false),
        title: NotSet,
        pronouns: NotSet,
        timezone: NotSet,
        bio: NotSet,
        avatar_key: NotSet,
        is_bot: Set(false),
        manual_presence: NotSet,
        created_at: NotSet,
        updated_at: NotSet,
    }
    .insert(&txn)
    .await?;

    let space = match std::env::var("RUCHOIR_ADMIN_SPACE") {
        Ok(name) if !name.trim().is_empty() => {
            let (_, slug) = create_owned_space(&txn, name.trim(), user_id)
                .await
                .map_err(|_| "could not create the first space")?;
            Some((name.trim().to_owned(), slug))
        }
        // No name given: the account signs in and creates its own space through onboarding, which
        // is a supported path. Inventing a name here would only put a word nobody chose on the rail.
        _ => None,
    };
    txn.commit().await?;

    tracing::info!(%email, "bootstrap: administrator created");
    match space {
        Some((name, slug)) => {
            tracing::info!(space = %name, slug = %slug, "bootstrap: first space created")
        }
        None => tracing::info!(
            "bootstrap: no RUCHOIR_ADMIN_SPACE set; the account will create its space on first sign-in"
        ),
    }
    Ok(())
}

/// A required value from the environment, with an error that names what to set.
fn env_value(key: &str) -> Result<String, Failure> {
    std::env::var(key).map_err(|_| format!("set {key} before running bootstrap").into())
}

/// The password, from the environment or from standard input.
///
/// Standard input is offered because it is the only one of the two that leaves no trace: an
/// environment variable is visible to anything that can read the process list on some systems, and
/// typing it as part of a command records it in the shell's history.
fn read_password() -> Result<String, Failure> {
    if let Ok(value) = std::env::var("RUCHOIR_ADMIN_PASSWORD") {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    if std::io::stdin().is_terminal() {
        return Err("set RUCHOIR_ADMIN_PASSWORD, or pipe the password on standard input".into());
    }
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let password = line.trim_end_matches(['\n', '\r']).to_owned();
    if password.is_empty() {
        return Err("no password on standard input".into());
    }
    Ok(password)
}
