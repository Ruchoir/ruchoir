//! Who is editing a file: each editor tab's heartbeat, kept in Valkey.
//!
//! `office:editing:<file>` is the set of `<member>:<tab>` entries seen; `office:beat:<file>:<member>:<tab>`
//! lives for [`EDITOR_TTL_SECS`] after each heartbeat. A member is editing while any of their tabs
//! beats, so closing one of two tabs does not make them vanish. An entry whose beat has lapsed is
//! dropped whenever the set is read.
//!
//! `office:editing:files` indexes the files someone is in. The sweep ([`spawn_sweep`]) reads them
//! every [`SWEEP_SECS`], so a tab that died without saying goodbye leaves the space's file lists
//! within a minute and a half, without anyone reloading.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use fred::interfaces::{KeysInterface, SetsInterface};
use fred::prelude::Pool;
use fred::types::Expiration;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use uuid::Uuid;

use crate::entities::{files, users};
use crate::files::dto::EditorDto;
use crate::state::AppState;

use super::error::OfficeError;

/// How long an editor tab counts as present after a heartbeat.
pub const EDITOR_TTL_SECS: i64 = 60;
/// How often the sweep looks for tabs that died without a goodbye.
const SWEEP_SECS: u64 = 30;
/// The files someone is editing.
const INDEX_KEY: &str = "office:editing:files";

fn set_key(file_id: Uuid) -> String {
    format!("office:editing:{file_id}")
}

fn beat_key(file_id: Uuid, entry: &str) -> String {
    format!("office:beat:{file_id}:{entry}")
}

fn entry(user_id: Uuid, tab: &str) -> String {
    format!("{user_id}:{tab}")
}

/// Whether a tab id is one the client may send: short, plain, safe inside a key.
pub fn valid_tab(tab: &str) -> bool {
    (1..=64).contains(&tab.len())
        && tab
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The distinct members of a list of entries, sorted.
fn members<'a>(entries: impl IntoIterator<Item = &'a String>) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = entries
        .into_iter()
        .filter_map(|e| e.split_once(':').and_then(|(id, _)| id.parse().ok()))
        .collect::<HashSet<Uuid>>()
        .into_iter()
        .collect();
    out.sort();
    out
}

fn internal<E>(_: E) -> OfficeError {
    OfficeError::Internal
}

/// Read the live editors of several files at once, dropping lapsed entries: one round trip for the
/// sets, one for the beats, whatever the number of files.
async fn read_many(
    valkey: &Pool,
    file_ids: &[Uuid],
) -> Result<HashMap<Uuid, (Vec<Uuid>, bool)>, OfficeError> {
    let mut out = HashMap::new();
    if file_ids.is_empty() {
        return Ok(out);
    }
    let pipeline = valkey.next().pipeline();
    for file_id in file_ids {
        let _: () = pipeline
            .smembers(set_key(*file_id).as_str())
            .await
            .map_err(internal)?;
    }
    let sets: Vec<Result<Vec<String>, _>> = pipeline.try_all().await;
    let mut entries: Vec<(Uuid, String)> = Vec::new();
    for (file_id, set) in file_ids.iter().zip(sets) {
        for e in set.map_err(internal)? {
            entries.push((*file_id, e));
        }
    }
    let beats: Vec<Option<String>> = if entries.is_empty() {
        Vec::new()
    } else {
        valkey
            .mget(
                entries
                    .iter()
                    .map(|(file_id, e)| beat_key(*file_id, e))
                    .collect::<Vec<_>>(),
            )
            .await
            .map_err(internal)?
    };
    let mut live: HashMap<Uuid, Vec<String>> = HashMap::new();
    let mut lapsed: HashMap<Uuid, Vec<String>> = HashMap::new();
    for ((file_id, e), beat) in entries.into_iter().zip(beats) {
        if beat.is_some() {
            live.entry(file_id).or_default().push(e);
        } else {
            lapsed.entry(file_id).or_default().push(e);
        }
    }
    for (file_id, gone) in &lapsed {
        let _: i64 = valkey
            .srem(set_key(*file_id).as_str(), gone.clone())
            .await
            .map_err(internal)?;
    }
    for file_id in file_ids {
        let now = live.remove(file_id).unwrap_or_default();
        let gone = lapsed.remove(file_id).unwrap_or_default();
        let after = members(&now);
        let changed = members(now.iter().chain(&gone)) != after;
        if now.is_empty() {
            let _: i64 = valkey
                .srem(INDEX_KEY, file_id.to_string())
                .await
                .map_err(internal)?;
        }
        out.insert(*file_id, (after, changed));
    }
    Ok(out)
}

/// The live editors of one file, and whether reading dropped someone whose tabs all lapsed.
async fn read(valkey: &Pool, file_id: Uuid) -> Result<(Vec<Uuid>, bool), OfficeError> {
    Ok(read_many(valkey, &[file_id])
        .await?
        .remove(&file_id)
        .unwrap_or_default())
}

/// Record a heartbeat from one tab. True when the set of editors changed (someone joined, or a
/// lapsed editor was dropped).
pub async fn beat(
    valkey: &Pool,
    file_id: Uuid,
    user_id: Uuid,
    tab: &str,
) -> Result<bool, OfficeError> {
    let (before, pruned) = read(valkey, file_id).await?;
    let e = entry(user_id, tab);
    let _: () = valkey
        .set(
            beat_key(file_id, &e).as_str(),
            "1",
            Some(Expiration::EX(EDITOR_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(internal)?;
    let _: i64 = valkey
        .sadd(set_key(file_id).as_str(), e)
        .await
        .map_err(internal)?;
    let _: () = valkey
        .expire(set_key(file_id).as_str(), EDITOR_TTL_SECS * 10, None)
        .await
        .map_err(internal)?;
    let _: i64 = valkey
        .sadd(INDEX_KEY, file_id.to_string())
        .await
        .map_err(internal)?;
    Ok(!before.contains(&user_id) || pruned)
}

/// One tab was closed. True when the set of editors changed (it was the member's last tab).
pub async fn leave(
    valkey: &Pool,
    file_id: Uuid,
    user_id: Uuid,
    tab: &str,
) -> Result<bool, OfficeError> {
    let (before, _) = read(valkey, file_id).await?;
    let e = entry(user_id, tab);
    let _: i64 = valkey
        .del(beat_key(file_id, &e).as_str())
        .await
        .map_err(internal)?;
    let _: i64 = valkey
        .srem(set_key(file_id).as_str(), e)
        .await
        .map_err(internal)?;
    let (after, _) = read(valkey, file_id).await?;
    Ok(before != after)
}

/// The members editing `file_id` now, lapsed tabs dropped.
pub async fn editors(valkey: &Pool, file_id: Uuid) -> Result<Vec<Uuid>, OfficeError> {
    Ok(read(valkey, file_id).await?.0)
}

/// The members editing each of `file_ids`, named, in two Valkey round trips and one query.
pub async fn named_editors_of(
    valkey: &Pool,
    db: &DatabaseConnection,
    file_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<EditorDto>>, OfficeError> {
    let live = read_many(valkey, file_ids).await?;
    let everyone: Vec<Uuid> = live
        .values()
        .flat_map(|(ids, _)| ids.iter().copied())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let names = names_of(db, everyone).await;
    Ok(live
        .into_iter()
        .map(|(file_id, (ids, _))| (file_id, with_names(ids, &names)))
        .collect())
}

/// Editors with their display names, in the given order.
pub async fn named(db: &DatabaseConnection, ids: Vec<Uuid>) -> Vec<EditorDto> {
    let names = names_of(db, ids.clone()).await;
    with_names(ids, &names)
}

async fn names_of(db: &DatabaseConnection, ids: Vec<Uuid>) -> HashMap<Uuid, String> {
    if ids.is_empty() {
        return HashMap::new();
    }
    users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect()
}

fn with_names(ids: Vec<Uuid>, names: &HashMap<Uuid, String>) -> Vec<EditorDto> {
    ids.into_iter()
        .map(|id| EditorDto {
            id,
            name: names.get(&id).cloned().unwrap_or_default(),
        })
        .collect()
}

/// The payload of `files.editing`.
#[derive(Serialize)]
struct FilesEditingEvent {
    space_id: Uuid,
    file_id: Uuid,
    editors: Vec<EditorDto>,
}

/// Tell the people who can see `file` who is editing it now. `actor` is whoever caused the change,
/// used to resolve a conversation's audience.
pub(crate) async fn publish(state: &AppState, file: &files::Model, actor: Uuid) {
    let ids = editors(&state.valkey, file.id).await.unwrap_or_default();
    let editors = named(&state.db, ids).await;
    let audience = crate::files::versions::file_audience(&state.db, file, actor).await;
    state
        .hub
        .publish(
            audience,
            crate::realtime::event::RealtimeEnvelope::files_editing(FilesEditingEvent {
                space_id: file.space_id,
                file_id: file.id,
                editors,
            }),
        )
        .await;
}

/// One pass of the sweep: every file someone was editing is read again, and the space is told
/// about the ones a lapsed tab left.
pub async fn sweep_once(state: &AppState) {
    let indexed: Vec<String> = match state.valkey.smembers(INDEX_KEY).await {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(%error, "office presence sweep could not read its index");
            return;
        }
    };
    let file_ids: Vec<Uuid> = indexed.iter().filter_map(|id| id.parse().ok()).collect();
    let Ok(live) = read_many(&state.valkey, &file_ids).await else {
        return;
    };
    for (file_id, (_, changed)) in live {
        if !changed {
            continue;
        }
        let Ok(Some(file)) = files::Entity::find_by_id(file_id).one(&state.db).await else {
            continue;
        };
        // Nobody acted: the conversation's audience, if any, is resolved through its owner.
        let actor = file.owner_id.unwrap_or_default();
        publish(state, &file, actor).await;
    }
}

/// Run the sweep in the background for as long as the server runs.
pub fn spawn_sweep(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(SWEEP_SECS)).await;
            sweep_once(&state).await;
        }
    });
}
