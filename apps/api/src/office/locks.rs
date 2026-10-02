//! WOPI locks, in Valkey so several API instances agree.
//!
//! A lock also remembers the version the file was at when it was taken. While it is held, the
//! engine is told that version (see `wopi::check_file_info`): Euro-Office derives a session's key
//! from the version and modification time it is given, and a member who joins after an autosave
//! moved the file forward must land in the session already running, not start a second one.
//!
//! Read-then-write without a transaction: the engine serialises its own lock calls for a document,
//! and two engines racing on one file is not a configuration this supports.

use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::error::OfficeError;

const PREFIX: &str = "office:lock:";
/// How long a lock lives without a refresh. The engine refreshes every ten minutes.
pub const LOCK_TTL_SECS: i64 = 1800;

/// A held lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub lock: String,
    pub version_id: Uuid,
    pub modified_at: String,
}

/// The result of a lock operation. `Conflict` carries the current lock (empty when none), which
/// WOPI returns in `X-WOPI-Lock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Conflict(String),
}

pub async fn current(valkey: &Pool, file_id: Uuid) -> Result<Option<Held>, OfficeError> {
    let key = format!("{PREFIX}{file_id}");
    let json: Option<String> = valkey
        .get(key.as_str())
        .await
        .map_err(|_| OfficeError::Internal)?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

async fn put(valkey: &Pool, file_id: Uuid, held: &Held) -> Result<(), OfficeError> {
    let key = format!("{PREFIX}{file_id}");
    let json = serde_json::to_string(held).map_err(|_| OfficeError::Internal)?;
    let _: () = valkey
        .set(
            key.as_str(),
            json,
            Some(Expiration::EX(LOCK_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| OfficeError::Internal)?;
    Ok(())
}

/// `Lock`, or unlock-and-relock when `old` is given. `at` is the file's current version and
/// modification time, recorded when the lock is first taken.
pub async fn lock(
    valkey: &Pool,
    file_id: Uuid,
    requested: &str,
    old: Option<&str>,
    at: (Uuid, String),
) -> Result<Outcome, OfficeError> {
    let current = current(valkey, file_id).await?;
    match (old, current) {
        (Some(old), Some(held)) if held.lock == old => {
            put(
                valkey,
                file_id,
                &Held {
                    lock: requested.to_owned(),
                    ..held
                },
            )
            .await?;
            Ok(Outcome::Ok)
        }
        (Some(_), held) => Ok(Outcome::Conflict(held.map(|h| h.lock).unwrap_or_default())),
        (None, Some(held)) if held.lock == requested => {
            put(valkey, file_id, &held).await?;
            Ok(Outcome::Ok)
        }
        (None, Some(held)) => Ok(Outcome::Conflict(held.lock)),
        (None, None) => {
            let (version_id, modified_at) = at;
            put(
                valkey,
                file_id,
                &Held {
                    lock: requested.to_owned(),
                    version_id,
                    modified_at,
                },
            )
            .await?;
            Ok(Outcome::Ok)
        }
    }
}

/// `RefreshLock`.
pub async fn refresh(
    valkey: &Pool,
    file_id: Uuid,
    requested: &str,
) -> Result<Outcome, OfficeError> {
    match current(valkey, file_id).await? {
        Some(held) if held.lock == requested => {
            put(valkey, file_id, &held).await?;
            Ok(Outcome::Ok)
        }
        held => Ok(Outcome::Conflict(held.map(|h| h.lock).unwrap_or_default())),
    }
}

/// `Unlock`.
pub async fn unlock(valkey: &Pool, file_id: Uuid, requested: &str) -> Result<Outcome, OfficeError> {
    match current(valkey, file_id).await? {
        Some(held) if held.lock == requested => {
            let key = format!("{PREFIX}{file_id}");
            let _: () = valkey
                .del(key.as_str())
                .await
                .map_err(|_| OfficeError::Internal)?;
            Ok(Outcome::Ok)
        }
        held => Ok(Outcome::Conflict(held.map(|h| h.lock).unwrap_or_default())),
    }
}
