//! What an import did with people, kept where it can be read again.
//!
//! At the end of a run (also a cancelled one) the counts are written to the job
//! (`import_jobs.summary`), so the done screen is the same after a reload, and one `import.applied`
//! line per touched space goes to the space's journal: a line per import and space, never one per
//! imported person. A space where the run changed nothing the line would say gets no line, so a
//! re-run leaves no empty entry behind.

use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::people::PeopleWritten;
use super::run::{Result, RunError};
use crate::audit::{record, Action, Target};
use crate::edition::{seats_used, Edition, Entitlement};
use crate::entities::import_jobs;

/// How many names of a list the summary spells out.
const NAMES_SHOWN: usize = 5;

/// A role of the source that this server could not create, and where it went instead.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct FallbackSummary {
    /// The space it happened in.
    pub space: String,
    /// The role of the source, by name.
    pub role_name: String,
    /// The fixed role the people got instead: `member` or `admin`.
    pub fixed: String,
    pub people: usize,
}

/// A licensed space's seats around the run.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct SeatsSummary {
    pub space: String,
    pub used_before: u32,
    pub added: u32,
    pub total: u32,
}

/// What crossed, as the job reports it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct PeopleSummary {
    pub administrators: usize,
    pub guests: usize,
    pub moderators: usize,
    pub groups: usize,
    /// The first names of the groups the run made.
    pub group_names: Vec<String>,
    /// People who were in their space already and were left as they were.
    pub kept: usize,
    /// The first of their names.
    pub kept_names: Vec<String>,
    pub custom_roles: usize,
    pub fallbacks: Vec<FallbackSummary>,
    pub seats: Vec<SeatsSummary>,
}

/// Writes the summary to the job and the journal line to each space that changed.
pub async fn save(
    db: &DatabaseConnection,
    edition: &dyn Edition,
    job_id: Uuid,
    importer: Uuid,
    source: &str,
    people: &PeopleWritten,
) -> Result<()> {
    let mut seats = Vec::new();
    for counts in &people.spaces {
        let total = match edition.entitlement(db, counts.space_id).await? {
            Entitlement::Community => continue,
            Entitlement::Enterprise { seats, .. } | Entitlement::Frozen { seats, .. } => seats,
        };
        let used = seats_used(db, counts.space_id).await?;
        let added = u32::try_from(counts.seat_takers).unwrap_or(u32::MAX);
        seats.push(SeatsSummary {
            space: counts.name.clone(),
            used_before: used.saturating_sub(added),
            added,
            total,
        });
    }
    let summary = PeopleSummary {
        administrators: people.administrators,
        guests: people.guests,
        moderators: people.moderators,
        groups: people.groups,
        group_names: people
            .group_names
            .iter()
            .take(NAMES_SHOWN)
            .cloned()
            .collect(),
        kept: people.kept.len(),
        kept_names: people.kept.iter().take(NAMES_SHOWN).cloned().collect(),
        custom_roles: people.custom_roles,
        fallbacks: people
            .fallbacks
            .iter()
            .map(|f| FallbackSummary {
                space: f.space.clone(),
                role_name: f.role_name.clone(),
                fixed: f.fixed.clone(),
                people: f.people,
            })
            .collect(),
        seats,
    };

    if let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? {
        let mut model: import_jobs::ActiveModel = job.into();
        model.summary = Set(Some(
            serde_json::to_value(&summary).map_err(|e| RunError::Db(e.to_string()))?,
        ));
        model.update(db).await?;
    }

    for counts in people.spaces.iter().filter(|c| !c.is_empty()) {
        record(
            db,
            counts.space_id,
            Some(importer),
            Action::ImportApplied,
            Target::Space,
            serde_json::json!({
                "source": source,
                "job_id": job_id,
                "administrators": counts.administrators,
                "guests": counts.guests,
                "groups": counts.groups,
                "moderators": counts.moderators,
                "custom_roles": counts.custom_roles,
                "fallbacks": counts.fallbacks,
            }),
        )
        .await?;
    }
    Ok(())
}
