//! Reading a space's audit log: `GET /api/v1/spaces/{space_id}/audit`, for whoever holds
//! `audit.view` there (Administrator by default; a guest never does).
//!
//! Newest first, a page at a time (an opaque cursor, never an offset, so a page is the same whatever
//! was written since), filtered by person, family and date. Names are read now, not stored: a
//! deleted account reads as `null`, a deleted role or channel by the name its entry kept.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::{ConnectionTrait, DbBackend, Statement, Value as SqlValue};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use super::Action;
use crate::auth::extract::AuthSession;
use crate::messaging::error::ApiError;
use crate::permissions::catalogue::Permission;
use crate::permissions::check::Resource;
use crate::state::AppState;

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;
const CATEGORIES: [&str; 5] = ["members", "roles", "channels", "calendars", "licence"];

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/spaces/{space_id}/audit", get(read_log))
}

/// The filters and the page.
#[derive(Debug, Deserialize, IntoParams)]
pub struct AuditQuery {
    /// Only what this person did.
    actor: Option<Uuid>,
    /// Only one family: `members`, `roles`, `channels`, `calendars` or `licence`.
    category: Option<String>,
    /// Only what happened at or after this instant (RFC 3339).
    since: Option<String>,
    /// The `next` of the previous page.
    before: Option<String>,
    /// Entries per page, 1 to 100 (50 by default).
    limit: Option<u32>,
}

/// One page of the log, newest first.
#[derive(Debug, Serialize, ToSchema)]
pub struct AuditPageDto {
    pub entries: Vec<AuditEntryDto>,
    /// Pass as `before` for the next page; absent on the last one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// One change of rights.
#[derive(Debug, Serialize, ToSchema)]
pub struct AuditEntryDto {
    pub id: Uuid,
    /// RFC 3339.
    pub at: String,
    /// The dotted action (`role.created`, `member.removed`...).
    pub action: String,
    /// Its family, as the filter names it.
    pub category: String,
    /// Who did it; `null` once their account is deleted.
    pub actor: Option<AuditActorDto>,
    pub target: AuditTargetDto,
    /// Ids, role and permission names, before and after. Never a person's name or any content.
    #[schema(value_type = Object)]
    pub details: serde_json::Value,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuditActorDto {
    pub id: Uuid,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuditTargetDto {
    /// `member`, `role`, `channel`, `calendar`, `space` or `licence`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    /// Its name today, or the one the entry kept once it is gone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn cursor_of(at: OffsetDateTime, id: Uuid) -> String {
    format!("{}_{}", at.unix_timestamp_nanos() / 1_000, id.simple())
}

fn parse_cursor(cursor: &str) -> Option<(OffsetDateTime, Uuid)> {
    let (micros, id) = cursor.split_once('_')?;
    let at =
        OffsetDateTime::from_unix_timestamp_nanos(micros.parse::<i128>().ok()? * 1_000).ok()?;
    Some((at, Uuid::parse_str(id).ok()?))
}

/// The family of a stored action name; `other` for one this version does not know.
fn category_of(action: &str) -> &'static str {
    Action::ALL
        .iter()
        .find(|known| known.as_str() == action)
        .map_or("other", |known| known.category())
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/audit",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id"), AuditQuery),
    responses(
        (status = 200, description = "A page of the space's audit log, newest first", body = AuditPageDto),
        (status = 400, description = "An unknown family, a malformed date or cursor, or a limit outside 1 to 100"),
        (status = 403, description = "Not allowed to read this space's log")
    )
)]
pub async fn read_log(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<AuditPageDto>, ApiError> {
    crate::messaging::authz::ensure_permission(
        &state.db,
        space_id,
        session.user_id,
        Resource::Space,
        Permission::AuditView,
    )
    .await?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::BadRequest("a page holds 1 to 100 entries"));
    }

    let mut conditions = vec!["l.space_id = $1".to_owned()];
    let mut values: Vec<SqlValue> = vec![space_id.into()];
    if let Some(actor) = query.actor {
        values.push(actor.into());
        conditions.push(format!("l.actor_id = ${}", values.len()));
    }
    if let Some(category) = query.category.as_deref() {
        if !CATEGORIES.contains(&category) {
            return Err(ApiError::BadRequest("no such family of changes"));
        }
        let actions: Vec<String> = Action::ALL
            .iter()
            .filter(|action| action.category() == category)
            .map(|action| action.as_str().to_owned())
            .collect();
        values.push(actions.into());
        conditions.push(format!("l.action = ANY(${})", values.len()));
    }
    if let Some(since) = query.since.as_deref() {
        let since = OffsetDateTime::parse(since, &Rfc3339)
            .map_err(|_| ApiError::BadRequest("since is an RFC 3339 date"))?;
        values.push(since.into());
        conditions.push(format!("l.at >= ${}", values.len()));
    }
    if let Some(before) = query.before.as_deref() {
        let (at, id) =
            parse_cursor(before).ok_or(ApiError::BadRequest("not a cursor this log gave"))?;
        values.push(at.into());
        values.push(id.into());
        conditions.push(format!(
            "(l.at, l.id) < (${}, ${})",
            values.len() - 1,
            values.len()
        ));
    }
    let sql = format!(
        "SELECT l.id, l.at, l.action, l.actor_id, l.target_kind, l.target_id, l.details, \
                u.display_name, u.avatar_key \
           FROM space_audit_log l LEFT JOIN users u ON u.id = l.actor_id \
          WHERE {} ORDER BY l.at DESC, l.id DESC LIMIT {}",
        conditions.join(" AND "),
        limit + 1
    );
    let mut rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            values,
        ))
        .await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);

    struct Row {
        id: Uuid,
        at: OffsetDateTime,
        action: String,
        actor: Option<AuditActorDto>,
        kind: String,
        target: Option<Uuid>,
        details: serde_json::Value,
    }
    let mut read = Vec::with_capacity(rows.len());
    for row in rows {
        let actor = match (
            row.try_get::<Option<Uuid>>("", "actor_id")?,
            row.try_get::<Option<String>>("", "display_name")?,
        ) {
            (Some(id), Some(display_name)) => Some(AuditActorDto {
                id,
                display_name,
                avatar_url: row
                    .try_get::<Option<String>>("", "avatar_key")?
                    .map(|key| crate::files::avatar_url(id, &key)),
            }),
            _ => None,
        };
        read.push(Row {
            id: row.try_get("", "id")?,
            at: row.try_get("", "at")?,
            action: row.try_get("", "action")?,
            actor,
            kind: row.try_get("", "target_kind")?,
            target: row.try_get("", "target_id")?,
            details: row.try_get("", "details")?,
        });
    }

    let labels = labels(
        &state.db,
        space_id,
        read.iter()
            .filter_map(|row| Some((row.kind.as_str(), row.target?))),
    )
    .await?;
    let next = more
        .then(|| read.last().map(|row| cursor_of(row.at, row.id)))
        .flatten();
    let entries = read
        .into_iter()
        .map(|row| {
            let label = row
                .target
                .and_then(|id| labels.get(&(row.kind.clone(), id)).cloned())
                .or_else(|| {
                    // Gone since: the name the entry kept, for what has one.
                    (row.kind != "member")
                        .then(|| {
                            row.details
                                .get("name")
                                .and_then(|n| n.as_str())
                                .map(str::to_owned)
                        })
                        .flatten()
                });
            AuditEntryDto {
                id: row.id,
                at: row.at.format(&Rfc3339).unwrap_or_default(),
                category: category_of(&row.action).to_owned(),
                action: row.action,
                actor: row.actor,
                target: AuditTargetDto {
                    kind: row.kind,
                    id: row.target,
                    label,
                },
                details: row.details,
            }
        })
        .collect();
    Ok(Json(AuditPageDto { entries, next }))
}

/// The current name of each target, in four queries at most: people by display name, roles,
/// channels and calendars of this space only.
async fn labels<'a>(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    targets: impl Iterator<Item = (&'a str, Uuid)>,
) -> Result<HashMap<(String, Uuid), String>, ApiError> {
    let mut by_kind: HashMap<&str, HashSet<Uuid>> = HashMap::new();
    for (kind, id) in targets {
        by_kind.entry(kind).or_default().insert(id);
    }
    let mut labels = HashMap::new();
    for (kind, table, column, scoped) in [
        ("member", "users", "display_name", false),
        ("role", "space_roles", "name", true),
        ("channel", "channels", "name", true),
        ("calendar", "calendars", "name", true),
    ] {
        let Some(ids) = by_kind.get(kind) else {
            continue;
        };
        let ids: Vec<Uuid> = ids.iter().copied().collect();
        let sql = if scoped {
            format!("SELECT id, {column}::text AS label FROM {table} WHERE id = ANY($1) AND space_id = $2")
        } else {
            format!("SELECT id, {column}::text AS label FROM {table} WHERE id = ANY($1) AND $2::uuid IS NOT NULL")
        };
        for row in db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                sql,
                [ids.into(), space_id.into()],
            ))
            .await?
        {
            labels.insert(
                (kind.to_owned(), row.try_get::<Uuid>("", "id")?),
                row.try_get::<String>("", "label")?,
            );
        }
    }
    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::{cursor_of, parse_cursor};
    use time::macros::datetime;
    use uuid::Uuid;

    #[test]
    fn a_cursor_reads_back_to_the_microsecond() {
        let at = datetime!(2026-11-03 16:20:01.123456 UTC);
        let id = Uuid::new_v4();
        assert_eq!(parse_cursor(&cursor_of(at, id)), Some((at, id)));
        assert_eq!(parse_cursor("nonsense"), None);
        assert_eq!(parse_cursor("12_notauuid"), None);
    }
}
