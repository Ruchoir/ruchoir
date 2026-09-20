//! The import surface, for administrators of the instance.
//!
//! Four things an administrator does: look at what an archive would do, start it, watch it, and
//! stop it. Nothing here writes until the second of those, which is the whole point of the first.
//!
//! Every route answers `404` to anyone who does not administer the instance, never `403`: to
//! everyone else this surface does not exist, and a refusal that distinguishes "forbidden" from
//! "no such route" would confirm there is something here to attack.

use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, EntityTrait, QueryOrder};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{import_jobs, users};
use crate::messaging::error::ApiError;
use crate::state::AppState;

use super::plan::{self, AccountOutcome, Existing};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/imports", get(list_jobs).post(start))
        .route("/api/v1/imports/plan", post(preview))
        .route("/api/v1/imports/{id}", get(job))
        .route("/api/v1/imports/{id}/cancel", post(cancel))
        .route("/api/v1/imports/{id}/invitations", post(invite))
        .route("/api/v1/imports/{id}/people", get(people))
        // Auto-delivery and the served command-line tools.
        .merge(super::drops::router())
}

/// An archive an administrator points at, and the passphrase that opens it.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ArchiveRequest {
    /// A name inside the server's import directory. Never a path: see [`resolve`].
    pub file: String,
    /// Absent for an archive that was never sealed, which only happens in development.
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Set to empty the instance before importing: every space and every account except the one
    /// asking. Never a default, and refused unless the address matches and a backup less than a day
    /// old has been recorded.
    #[serde(default)]
    pub replace_everything: Option<ReplaceRequest>,
    /// What the administrator changed about the people after reading the plan: an address given to
    /// somebody the export carried without one, an address corrected, a person left out.
    ///
    /// Only the ones that changed. Everyone else arrives as the archive spells them.
    #[serde(default)]
    pub people: Vec<super::plan::PersonChoice>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReplaceRequest {
    /// The instance's own address, typed by hand. There is no instance name in the database, and
    /// this is the one an administrator reads in their browser every day.
    pub instance_address: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlanResponse {
    pub source: String,
    /// What replacing the instance would destroy, so the screen can show it next to what would
    /// arrive. Counted on every plan, whether or not a replacement is asked for: an administrator
    /// deciding between the two should see both halves at once.
    pub replacing_would_destroy: WhatDiesResponse,
    pub spaces: Vec<PlannedSpace>,
    pub accounts: PlannedAccounts,
    pub messages: usize,
    pub files: usize,
    /// The producer's own words, unchanged. Shown before the run, in full: summarising a declared
    /// loss is another way of hiding it.
    pub limits: Vec<String>,
    /// Problems the contract checks allow but an administrator should see, such as a reading
    /// position naming a message that did not cross.
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WhatDiesResponse {
    pub spaces: u64,
    pub accounts: u64,
    pub messages: u64,
    pub space_names: Vec<String>,
    /// When the last backup was recorded, if ever. A replacement is refused without a recent one.
    pub last_backup: Option<String>,
    pub replacement_allowed: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlannedSpace {
    pub name: String,
    /// `created` or `filled`.
    pub outcome: String,
    pub channels: usize,
    /// How many of those channels this space already has here, under the same handle: they take
    /// the archive's history instead of being created beside it.
    pub channels_filled: usize,
    pub directs: usize,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlannedAccounts {
    pub total: usize,
    pub matched: usize,
    pub invitable: usize,
    /// Accounts with no address at all. They arrive, they are placed, and they cannot be emailed:
    /// the administrator has to give them an address or hand them a link.
    pub without_address: usize,
    pub people: Vec<PlannedAccount>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlannedAccount {
    pub source_id: String,
    pub display_name: String,
    pub email: String,
    pub outcome: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct JobResponse {
    pub id: Uuid,
    pub source: String,
    pub status: String,
    pub accounts_done: i32,
    pub accounts_total: i32,
    pub channels_done: i32,
    pub channels_total: i32,
    pub messages_done: i32,
    pub messages_total: i32,
    pub files_done: i32,
    pub files_total: i32,
    pub error: Option<String>,
    /// When it ended, for an import the screen finds again rather than one it started itself.
    pub finished_at: Option<String>,
}

impl From<import_jobs::Model> for JobResponse {
    fn from(job: import_jobs::Model) -> Self {
        Self {
            id: job.id,
            source: job.source,
            status: job.status,
            accounts_done: job.accounts_done,
            accounts_total: job.accounts_total,
            channels_done: job.channels_done,
            channels_total: job.channels_total,
            messages_done: job.messages_done,
            messages_total: job.messages_total,
            files_done: job.files_done,
            files_total: job.files_total,
            error: job.error,
            finished_at: job.finished_at.map(crate::messaging::dto::rfc3339),
        }
    }
}

/// `POST /api/v1/imports/plan`: what this archive would do, without doing any of it.
#[utoipa::path(
    post,
    path = "/api/v1/imports/plan",
    tag = "import",
    request_body = ArchiveRequest,
    responses(
        (status = 200, description = "What the import would do", body = PlanResponse),
        (status = 400, description = "The archive does not hold together"),
        (status = 404, description = "Not an administrator of this instance")
    )
)]
pub async fn preview(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<ArchiveRequest>,
) -> Result<Json<PlanResponse>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let path = resolve(&state, &body.file)?;

    let (index, report) =
        super::check::check(&path, body.passphrase.as_deref()).map_err(|e| readable(&e))?;
    if !report.is_sound() {
        return Err(ApiError::BadRequestOwned(format!(
            "this archive does not hold together: {}",
            report.errors().join("; ")
        )));
    }

    let existing = existing_state(&state).await?;
    let plan = plan::build(&index, &existing);

    let dying = super::wipe::what_would_be_destroyed(&state.db)
        .await
        .map_err(|_| ApiError::Internal)?;
    let backup = super::wipe::last_backup(&state.db)
        .await
        .map_err(|_| ApiError::Internal)?;
    let recent = backup.as_ref().is_some_and(|event| {
        event.occurred_at > time::OffsetDateTime::now_utc() - super::wipe::BACKUP_MUST_BE_NEWER_THAN
    });

    Ok(Json(PlanResponse {
        source: plan.source.clone(),
        replacing_would_destroy: WhatDiesResponse {
            spaces: dying.spaces,
            accounts: dying.accounts,
            messages: dying.messages,
            space_names: dying.space_names,
            last_backup: backup.map(|event| event.occurred_at.to_string()),
            replacement_allowed: recent,
        },
        spaces: plan
            .spaces
            .iter()
            .map(|space| PlannedSpace {
                name: space.name.clone(),
                outcome: match space.outcome {
                    plan::SpaceOutcome::Created => "created".to_owned(),
                    plan::SpaceOutcome::Filled => "filled".to_owned(),
                },
                channels: space.channels,
                channels_filled: space.channels_filled,
                directs: space.directs,
            })
            .collect(),
        accounts: PlannedAccounts {
            total: plan.accounts.len(),
            matched: plan.accounts_with(AccountOutcome::Matched),
            invitable: plan.accounts_with(AccountOutcome::Invited),
            without_address: plan.accounts_with(AccountOutcome::NeedsDecision),
            people: plan
                .accounts
                .iter()
                .map(|account| PlannedAccount {
                    source_id: account.source_id.clone(),
                    display_name: account.display_name.clone(),
                    email: account.email.clone(),
                    outcome: match account.outcome {
                        AccountOutcome::Matched => "matched".to_owned(),
                        AccountOutcome::Invited => "invitable".to_owned(),
                        AccountOutcome::NeedsDecision => "without_address".to_owned(),
                    },
                })
                .collect(),
        },
        messages: plan.messages,
        files: plan.files,
        limits: plan.limits,
        warnings: report.warnings(),
    }))
}

/// `POST /api/v1/imports`: start one.
///
/// Answers as soon as the job exists rather than when it ends: an import runs for as long as it
/// runs, and a request that waited for it would time out somewhere in the middle and tell the
/// administrator nothing.
#[utoipa::path(
    post,
    path = "/api/v1/imports",
    tag = "import",
    request_body = ArchiveRequest,
    responses(
        (status = 202, description = "The import has started", body = JobResponse),
        (status = 400, description = "The archive does not hold together"),
        (status = 404, description = "Not an administrator of this instance"),
        (status = 409, description = "An import is already running")
    )
)]
pub async fn start(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<ArchiveRequest>,
) -> Result<(axum::http::StatusCode, Json<JobResponse>), ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    // One at a time. Two would write over each other's progress and race on the same accounts,
    // and the answer to "why did my import stop counting" would be another import.
    if super::run::one_is_running(&state.db)
        .await
        .map_err(|_| ApiError::Internal)?
    {
        return Err(ApiError::Conflict(
            "an import is already running on this instance",
        ));
    }
    let path = resolve(&state, &body.file)?;

    let db = state.db.clone();
    let storage = state.storage.clone();
    let admin = session.user_id;
    let passphrase = body.passphrase.clone();

    // The job row has to exist before the response, or the screen has nothing to watch.
    let (index, _) = super::check::check(&path, passphrase.as_deref()).map_err(|e| readable(&e))?;
    let source = index
        .manifest
        .as_ref()
        .map(|manifest| manifest.source.clone())
        .unwrap_or_default();
    // The replacement happens before the job exists, and before anything is imported: an
    // administrator who asked for it and got a refusal has lost nothing, where one who got it
    // halfway through an import would have lost everything twice.
    if let Some(replace) = &body.replace_everything {
        super::wipe::replace_instance(
            &db,
            admin,
            &replace.instance_address,
            &state.config.public_base_url,
        )
        .await
        .map_err(|e| ApiError::BadRequestOwned(e.to_string()))?;
    }

    // Written on to the job, not held in this request: an import resumed tomorrow has to make the
    // same decisions about the same people as the one that started today.
    let options = serde_json::json!({ "people": body.people }).to_string();
    let job_id = super::run::start_job(&db, &source, admin, None, &options)
        .await
        .map_err(|e| ApiError::BadRequestOwned(e.to_string()))?;

    tokio::spawn(async move {
        // The passphrase lives in this task and nowhere else, and goes when it ends.
        let outcome = super::job::execute_into(
            &db,
            storage.as_deref(),
            &path,
            passphrase.as_deref(),
            admin,
            job_id,
        )
        .await;
        if let Err(error) = outcome {
            tracing::error!(%error, %job_id, "the import stopped");
        }
    });

    let job = import_jobs::Entity::find_by_id(job_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok((axum::http::StatusCode::ACCEPTED, Json(job.into())))
}

/// `GET /api/v1/imports`: every import this instance has run, most recent first.
#[utoipa::path(
    get,
    path = "/api/v1/imports",
    tag = "import",
    responses(
        (status = 200, description = "The imports", body = Vec<JobResponse>),
        (status = 404, description = "Not an administrator of this instance")
    )
)]
pub async fn list_jobs(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<JobResponse>>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let jobs = import_jobs::Entity::find()
        .order_by_desc(import_jobs::Column::CreatedAt)
        .all(&state.db)
        .await?;
    Ok(Json(jobs.into_iter().map(JobResponse::from).collect()))
}

/// `GET /api/v1/imports/{id}`: where one has got to.
#[utoipa::path(
    get,
    path = "/api/v1/imports/{id}",
    tag = "import",
    responses(
        (status = 200, description = "The import", body = JobResponse),
        (status = 404, description = "No such import, or not an administrator")
    )
)]
pub async fn job(
    State(state): State<AppState>,
    session: AuthSession,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<JobResponse>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let job = import_jobs::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(job.into()))
}

/// `POST /api/v1/imports/{id}/cancel`: ask it to stop.
///
/// It stops at the next conversation and keeps everything already written. Running the same archive
/// again picks up where this left off, because resuming and re-importing are the same mechanism.
#[utoipa::path(
    post,
    path = "/api/v1/imports/{id}/cancel",
    tag = "import",
    responses(
        (status = 200, description = "It will stop at the next conversation", body = JobResponse),
        (status = 404, description = "No such import, or not an administrator"),
        (status = 409, description = "That import is not running")
    )
)]
pub async fn cancel(
    State(state): State<AppState>,
    session: AuthSession,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<JobResponse>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let job = import_jobs::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if job.status != "running" {
        return Err(ApiError::Conflict("that import is not running"));
    }

    let mut model: import_jobs::ActiveModel = job.into();
    model.status = Set("cancelling".to_owned());
    let job = model.update(&state.db).await?;
    Ok(Json(job.into()))
}

/// Turns an archive failure into something safe to send back.
///
/// A wrong passphrase, a missing member and an unsupported version are all worth saying in full:
/// each names something the administrator can fix. A parse failure is not, because its detail
/// quotes the bytes it choked on, and bytes from a file are not ours to echo. It goes to the log
/// and the caller gets the fact.
fn readable(error: &super::archive::ArchiveError) -> ApiError {
    use super::archive::ArchiveError;
    match error {
        ArchiveError::WrongPassphrase
        | ArchiveError::PassphraseMissing
        | ArchiveError::MissingMember(_)
        | ArchiveError::UnsupportedVersion { .. } => ApiError::BadRequestOwned(error.to_string()),
        ArchiveError::BadRecord { file, line, .. } => {
            ApiError::BadRequestOwned(format!("{file}, line {line}, is not a record we can read"))
        }
        ArchiveError::Unreadable(detail) | ArchiveError::Io(detail) => {
            tracing::warn!(%detail, "an archive could not be read");
            ApiError::BadRequest("this file is not a Ruchoir import archive")
        }
    }
}

/// Turns a name into a path inside the import directory, and refuses everything else.
///
/// A name, never a path: an administrator is trusted with the instance, not handed a way to make
/// the API open any file on the machine and report what it found. The directory has to be
/// configured for this door to exist at all.
fn resolve(state: &AppState, file: &str) -> Result<std::path::PathBuf, ApiError> {
    let Some(directory) = &state.config.import_dir else {
        return Err(ApiError::BadRequest(
            "this instance accepts no archive from the server: set the import directory first",
        ));
    };
    if file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || file.starts_with('.')
    {
        return Err(ApiError::BadRequest(
            "give the name of a file in the import directory, not a path",
        ));
    }
    let path = directory.join(file);
    if !path.exists() {
        return Err(ApiError::BadRequest(
            "no archive of that name is in the import directory",
        ));
    }
    Ok(path)
}

async fn existing_state(state: &AppState) -> Result<Existing, ApiError> {
    use crate::entities::spaces;

    let emails = users::Entity::find()
        .all(&state.db)
        .await?
        .into_iter()
        .map(|user| user.email)
        .collect();
    let space_names = spaces::Entity::find()
        .all(&state.db)
        .await?
        .into_iter()
        .map(|space| space.name)
        .collect();
    Ok(Existing {
        emails,
        space_names,
        channels: super::run::existing_channels(&state.db).await?,
    })
}

/// Confirm the caller administers this instance.
///
/// Answers `404`, not `403`, for the reason given at the top of this file.
pub(super) async fn ensure_instance_admin(state: &AppState, user_id: Uuid) -> Result<(), ApiError> {
    let is_admin = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .is_some_and(|user| user.is_instance_admin);
    if is_admin {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

// --- Invitations -----------------------------------------------------------------------------
//
// An import places people. It does not write to any of them: ten thousand accounts arriving is
// not ten thousand emails leaving, and an administrator who imported a rehearsal at four in the
// afternoon would otherwise find out by being telephoned. Sending is a separate act, asked for by
// name, on a list the administrator has read.

/// Who to write to. Source identifiers, as the archive spells them.
#[derive(Debug, Deserialize, ToSchema)]
pub struct InviteRequest {
    pub source_ids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct InviteResponse {
    /// How many emails the relay accepted.
    pub sent: usize,
    /// Who was passed over, and why, in words meant for the administrator.
    pub skipped: Vec<SkippedInvite>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SkippedInvite {
    pub source_id: String,
    pub reason: String,
}

/// One of the accounts an import brought over, as it stands now.
#[derive(Debug, Serialize, ToSchema)]
pub struct ImportedPerson {
    pub source_id: String,
    pub display_name: String,
    /// Empty when the archive carried none and nobody gave one: they cannot be invited by mail.
    pub email: String,
    /// Whether an invitation has already gone to that address.
    pub invited: bool,
}

/// `GET /api/v1/imports/{id}/people`: who this import brought over.
///
/// The screen knows the people from the plan it read before the run - but only while it stays open.
/// An administrator who closes it during an hour-long import and comes back has no plan, and no way
/// to send the invitations, which is the one thing left to do at the end. This answers from the
/// correspondences instead, and those outlive the screen.
///
/// By source rather than by job, like every other lookup of a correspondence: an import resumed in a
/// second job brought over the people the first one recorded, and they are the same people.
#[utoipa::path(
    get,
    path = "/api/v1/imports/{id}/people",
    tag = "import",
    params(("id" = Uuid, Path, description = "Import job id")),
    responses(
        (status = 200, description = "The accounts this import brought over", body = Vec<ImportedPerson>),
        (status = 404, description = "Not an administrator of this instance, or no such import")
    )
)]
pub async fn people(
    State(state): State<AppState>,
    session: AuthSession,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<Vec<ImportedPerson>>, ApiError> {
    use crate::entities::{import_mappings, space_invitations};
    use sea_orm::{ColumnTrait, QueryFilter};

    ensure_instance_admin(&state, session.user_id).await?;
    let Some(job) = import_jobs::Entity::find_by_id(id).one(&state.db).await? else {
        return Err(ApiError::NotFound);
    };

    let correspondences = import_mappings::Entity::find()
        .filter(import_mappings::Column::Source.eq(job.source))
        .filter(import_mappings::Column::Kind.eq(super::run::KIND_USER))
        .all(&state.db)
        .await?;
    if correspondences.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let accounts = users::Entity::find()
        .filter(users::Column::Id.is_in(correspondences.iter().map(|row| row.internal_id)))
        .all(&state.db)
        .await?;
    let by_id: std::collections::HashMap<Uuid, users::Model> =
        accounts.into_iter().map(|user| (user.id, user)).collect();

    // One query for the addresses already written to, rather than one per person.
    let addresses: Vec<String> = by_id
        .values()
        .map(|user| user.email.clone())
        .filter(|email| !super::run::unreachable(email))
        .collect();
    let invited: std::collections::HashSet<String> = if addresses.is_empty() {
        std::collections::HashSet::new()
    } else {
        space_invitations::Entity::find()
            .filter(space_invitations::Column::Email.is_in(addresses))
            .filter(space_invitations::Column::RevokedAt.is_null())
            .all(&state.db)
            .await?
            .into_iter()
            .filter_map(|invitation| invitation.email)
            .collect()
    };

    let mut out: Vec<ImportedPerson> = correspondences
        .into_iter()
        .filter_map(|row| {
            let user = by_id.get(&row.internal_id)?;
            // Somebody who arrived without an address reads as having none, which is what they
            // have: the one they were given cannot receive anything.
            let reachable = !super::run::unreachable(&user.email);
            Some(ImportedPerson {
                source_id: row.external_ref,
                display_name: user.display_name.clone(),
                email: if reachable { user.email.clone() } else { String::new() },
                invited: reachable && invited.contains(&user.email),
            })
        })
        .collect();
    // Read by a person, so ordered the way a list of people is.
    out.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(Json(out))
}

/// `POST /api/v1/imports/{id}/invitations`: write to the people this import brought over.
#[utoipa::path(
    post,
    path = "/api/v1/imports/{id}/invitations",
    tag = "import",
    params(("id" = Uuid, Path, description = "Import job id")),
    request_body = InviteRequest,
    responses(
        (status = 200, description = "What was sent and what was not", body = InviteResponse),
        (status = 404, description = "Not an administrator of this instance, or no such import")
    )
)]
pub async fn invite(
    State(state): State<AppState>,
    session: AuthSession,
    AxumPath(id): AxumPath<Uuid>,
    Json(body): Json<InviteRequest>,
) -> Result<Json<InviteResponse>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let Some(job) = import_jobs::Entity::find_by_id(id).one(&state.db).await? else {
        return Err(ApiError::NotFound);
    };

    // Said once, up front, rather than as a hundred identical failures: an instance with no relay
    // cannot send anything, and the administrator needs to know that and not a list.
    if !state.mailer.can_send() {
        return Err(ApiError::BadRequest(
            "this instance has no mail relay configured, so no invitation can be sent",
        ));
    }

    let mut sent = 0usize;
    let mut skipped = Vec::new();
    for source_id in &body.source_ids {
        match invite_one(&state, &job, source_id, session.user_id).await {
            Ok(()) => sent += 1,
            Err(reason) => skipped.push(SkippedInvite {
                source_id: source_id.clone(),
                reason,
            }),
        }
    }

    Ok(Json(InviteResponse { sent, skipped }))
}

/// One invitation, or the reason there is none.
///
/// The reasons are returned rather than logged: an administrator looking at "three of two hundred
/// were not written to" needs to know which three and why, and the answer is usually something
/// they can fix.
async fn invite_one(
    state: &AppState,
    job: &import_jobs::Model,
    source_id: &str,
    inviter: Uuid,
) -> Result<(), String> {
    use crate::entities::{space_invitations, space_members};
    use sea_orm::{ColumnTrait, QueryFilter};

    let mapper = super::run::Mapper::new(job.id, &job.source);
    let Some(user_id) = mapper
        .resolve(&state.db, super::run::KIND_USER, source_id, None)
        .await
        .map_err(|_| "could not be looked up".to_owned())?
    else {
        return Err("was not among the accounts this import created".to_owned());
    };

    let Some(user) = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .map_err(|_| "could not be looked up".to_owned())?
    else {
        return Err("no longer has an account here".to_owned());
    };
    // Includes the address the import gives somebody who arrived without one: it exists so the
    // column can be filled, and writing to it would only bounce.
    if super::run::unreachable(&user.email) {
        return Err("has no address".to_owned());
    }

    // The space they were placed in. An invitation is to a space in this product, and the one they
    // are already a member of is the one that will mean something when they arrive.
    let Some(membership) = space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(user_id))
        .one(&state.db)
        .await
        .map_err(|_| "could not be looked up".to_owned())?
    else {
        return Err("was not placed in any space".to_owned());
    };

    let raw = crate::auth::tokens::generate_token().map_err(|_| "no token".to_owned())?;
    let now = time::OffsetDateTime::now_utc();
    space_invitations::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(membership.space_id),
        token_hash: Set(crate::auth::tokens::digest(&raw)),
        email: Set(Some(user.email.clone())),
        // The role they had where they came from is not carried: an import does not hand out
        // administration, and a space administrator can raise them afterwards.
        role: Set("member".to_owned()),
        created_by: Set(Some(inviter)),
        max_uses: Set(Some(1)),
        uses: Set(0),
        expires_at: Set(Some(now + time::Duration::days(14))),
        revoked_at: Set(None),
        created_at: Set(now),
    }
    .insert(&state.db)
    .await
    .map_err(|_| "the invitation could not be written".to_owned())?;

    let base = state.mailer.base_url.trim_end_matches('/');
    let url = format!("{base}/invite?token={raw}");
    if crate::messaging::invitations::send_invitation_email(
        state,
        &user.email,
        membership.space_id,
        &url,
        inviter,
    )
    .await
    {
        Ok(())
    } else {
        // The invitation exists and can still be handed over by hand, which is why this is a
        // reason and not a rollback.
        Err("the relay refused the message; the invitation is waiting on the space".to_owned())
    }
}
