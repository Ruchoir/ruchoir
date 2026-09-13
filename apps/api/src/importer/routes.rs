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

    let job_id = super::run::start_job(&db, &source, admin, None)
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
    })
}

/// Confirm the caller administers this instance.
///
/// Answers `404`, not `403`, for the reason given at the top of this file.
async fn ensure_instance_admin(state: &AppState, user_id: Uuid) -> Result<(), ApiError> {
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
