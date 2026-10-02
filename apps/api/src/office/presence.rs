//! Who is editing a file: an editor page's heartbeat, kept in Valkey.
//!
//! `office:editing:<file>` is the set of member ids seen; `office:beat:<file>:<member>` lives for
//! [`EDITOR_TTL_SECS`] after each heartbeat. A member whose beat has lapsed is dropped the next time
//! the set is read, so a crashed tab leaves within a minute of the next heartbeat of anyone else,
//! or at the next listing.

use std::collections::HashMap;

use fred::interfaces::{KeysInterface, SetsInterface};
use fred::prelude::Pool;
use fred::types::Expiration;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use crate::entities::users;
use crate::files::dto::EditorDto;

use super::error::OfficeError;

/// How long an editor counts as present after a heartbeat.
pub const EDITOR_TTL_SECS: i64 = 60;

fn set_key(file_id: Uuid) -> String {
    format!("office:editing:{file_id}")
}

fn beat_key(file_id: Uuid, user_id: Uuid) -> String {
    format!("office:beat:{file_id}:{user_id}")
}

/// Record a heartbeat. True when the set of editors changed (someone joined, or a lapsed editor was
/// dropped).
pub async fn beat(valkey: &Pool, file_id: Uuid, user_id: Uuid) -> Result<bool, OfficeError> {
    let (before, pruned) = read(valkey, file_id).await?;
    let _: () = valkey
        .set(
            beat_key(file_id, user_id).as_str(),
            "1",
            Some(Expiration::EX(EDITOR_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| OfficeError::Internal)?;
    let _: i64 = valkey
        .sadd(set_key(file_id).as_str(), user_id.to_string())
        .await
        .map_err(|_| OfficeError::Internal)?;
    let _: () = valkey
        .expire(set_key(file_id).as_str(), EDITOR_TTL_SECS * 10, None)
        .await
        .map_err(|_| OfficeError::Internal)?;
    // Changed when the member is new, or when reading the set dropped someone whose beat lapsed.
    Ok(!before.contains(&user_id) || pruned)
}

/// The editor page was closed. True when the member was listed.
pub async fn leave(valkey: &Pool, file_id: Uuid, user_id: Uuid) -> Result<bool, OfficeError> {
    let _: () = valkey
        .del(beat_key(file_id, user_id).as_str())
        .await
        .map_err(|_| OfficeError::Internal)?;
    let removed: i64 = valkey
        .srem(set_key(file_id).as_str(), user_id.to_string())
        .await
        .map_err(|_| OfficeError::Internal)?;
    Ok(removed > 0)
}

/// The members editing `file_id` now, lapsed ones dropped.
pub async fn editors(valkey: &Pool, file_id: Uuid) -> Result<Vec<Uuid>, OfficeError> {
    Ok(read(valkey, file_id).await?.0)
}

/// The live members, and whether reading dropped a lapsed one.
async fn read(valkey: &Pool, file_id: Uuid) -> Result<(Vec<Uuid>, bool), OfficeError> {
    let members: Vec<String> = valkey
        .smembers(set_key(file_id).as_str())
        .await
        .map_err(|_| OfficeError::Internal)?;
    let mut live = Vec::new();
    let mut pruned = false;
    for member in members {
        let Ok(user_id) = member.parse::<Uuid>() else {
            continue;
        };
        let alive: i64 = valkey
            .exists(beat_key(file_id, user_id).as_str())
            .await
            .map_err(|_| OfficeError::Internal)?;
        if alive > 0 {
            live.push(user_id);
        } else {
            let _: i64 = valkey
                .srem(set_key(file_id).as_str(), member)
                .await
                .map_err(|_| OfficeError::Internal)?;
            pruned = true;
        }
    }
    live.sort();
    Ok((live, pruned))
}

/// Editors with their display names, in the given order.
pub async fn named(db: &DatabaseConnection, ids: Vec<Uuid>) -> Vec<EditorDto> {
    if ids.is_empty() {
        return Vec::new();
    }
    let names: HashMap<Uuid, String> = users::Entity::find()
        .filter(users::Column::Id.is_in(ids.clone()))
        .all(db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect();
    ids.into_iter()
        .map(|id| EditorDto {
            id,
            name: names.get(&id).cloned().unwrap_or_default(),
        })
        .collect()
}
