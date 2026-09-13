//! Running a whole import, in order, with the job row kept honest as it goes.
//!
//! The passes have a hard order and it is not a preference: conversations need their spaces and
//! their accounts, messages need their conversations, attachments need both their message and their
//! file, and a reading position needs the message it points at. Running them in any other order
//! produces rows pointing at nothing.
//!
//! Progress is written to the job row after each pass rather than after each entity. An import of
//! several gigabytes would otherwise spend a meaningful share of its time telling a screen about
//! itself, and nobody watches a counter that closely.

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use crate::entities::import_jobs;

use super::plan::{self, Existing, Plan};
use super::run::{self, BlobSink, Mapper, RunError, Written};

/// What an import did, once it is over.
#[derive(Debug, Default)]
pub struct Outcome {
    pub written: Written,
    /// The producer's own words about what it left behind, carried through to the report so the
    /// administrator reads the same sentence at the end as at the start.
    pub limits: Vec<String>,
}

/// Runs every pass against an archive, from an empty instance or on top of an earlier attempt.
///
/// Re-running the same archive is the same call: each pass recognises what it already wrote.
pub async fn execute<S: BlobSink>(
    db: &DatabaseConnection,
    storage: Option<&S>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    admin: Uuid,
) -> Result<Outcome, RunError> {
    let (index, report) =
        super::check::check(archive, passphrase).map_err(|e| RunError::Db(e.to_string()))?;
    if !report.is_sound() {
        // Refusing here costs nothing; refusing halfway costs an administrator their afternoon.
        return Err(RunError::Ambiguous(format!(
            "this archive does not hold together: {}",
            report.errors().join("; ")
        )));
    }

    let source = index
        .manifest
        .as_ref()
        .map(|manifest| manifest.source.clone())
        .unwrap_or_default();

    if let Some(running) = import_jobs::Entity::find()
        .filter(import_jobs::Column::Status.eq("running"))
        .one(db)
        .await?
    {
        // One at a time per instance. Two imports writing into the same spaces would each see half
        // of the other's work and neither would be resumable.
        return Err(RunError::Ambiguous(format!(
            "an import started at {} is still running",
            running
                .started_at
                .map(|at| at.to_string())
                .unwrap_or_else(|| "an unknown time".to_owned())
        )));
    }

    let existing = existing_state(db).await?;
    let plan: Plan = plan::build(&index, &existing);

    let job_id = run::start_job(db, &source, admin, None, "{}").await?;
    run_passes(db, storage, archive, passphrase, admin, job_id, index, plan).await
}

/// The same run, against a job row that already exists.
///
/// The HTTP surface creates the row before answering, so the screen has something to watch from the
/// first frame; the command line lets `execute` create it. Both end up here.
pub async fn execute_into<S: BlobSink>(
    db: &DatabaseConnection,
    storage: Option<&S>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    admin: Uuid,
    job_id: Uuid,
) -> Result<Outcome, RunError> {
    let (index, report) =
        super::check::check(archive, passphrase).map_err(|e| RunError::Db(e.to_string()))?;
    if !report.is_sound() {
        let reason = format!(
            "this archive does not hold together: {}",
            report.errors().join("; ")
        );
        finish(db, job_id, "failed", &reason).await?;
        return Err(RunError::Ambiguous(reason));
    }
    let existing = existing_state(db).await?;
    let plan = plan::build(&index, &existing);
    run_passes(db, storage, archive, passphrase, admin, job_id, index, plan).await
}

#[allow(clippy::too_many_arguments)]
async fn run_passes<S: BlobSink>(
    db: &DatabaseConnection,
    storage: Option<&S>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    admin: Uuid,
    job_id: Uuid,
    index: super::archive::Index,
    mut plan: Plan,
) -> Result<Outcome, RunError> {
    let source = index
        .manifest
        .as_ref()
        .map(|manifest| manifest.source.clone())
        .unwrap_or_default();
    // What the administrator decided about the people, read back off the job rather than passed
    // in: a resumed run has only the job to go on.
    let choices: Vec<plan::PersonChoice> = import_jobs::Entity::find_by_id(job_id)
        .one(db)
        .await?
        .and_then(|job| serde_json::from_str::<serde_json::Value>(&job.options).ok())
        .and_then(|options| serde_json::from_value(options.get("people")?.clone()).ok())
        .unwrap_or_default();
    if !choices.is_empty() {
        let existing = existing_state(db).await?;
        plan::apply_choices(&mut plan, &choices, &existing);
    }

    let mapper = Mapper::new(job_id, &source);
    // Read once, in one query, rather than asked for a row at a time by every pass that follows.
    let known = mapper.preload(db).await?;
    if known > 0 {
        tracing::info!(known, "resuming: correspondences from an earlier run are already here");
    }

    let mut totals = import_jobs::Entity::find_by_id(job_id)
        .one(db)
        .await?
        .ok_or_else(|| RunError::Db("the job disappeared as it started".to_owned()))?
        .into_active_model_for_totals();
    totals.accounts_total = Set(plan.accounts.len() as i32);
    totals.channels_total = Set(index.channels.len() as i32);
    totals.messages_total = Set(index.message_count as i32);
    totals.files_total = Set(index.files.len() as i32);
    totals.manifest = Set(index
        .manifest
        .as_ref()
        .and_then(|manifest| serde_json::to_string(&manifest.limits).ok()));
    totals.update(db).await?;

    let mut written = Written::default();

    let accounts = run::import_accounts(db, &mapper, &plan).await?;
    written.accounts_created = accounts.accounts_created;
    written.accounts_matched = accounts.accounts_matched;
    note_progress(db, job_id, &written).await?;

    let (spaces, resolved) = run::import_spaces(db, &mapper, &index, admin).await?;
    written.spaces_created = spaces.spaces_created;
    written.spaces_filled = spaces.spaces_filled;
    written.memberships += spaces.memberships;

    let conversations = run::import_conversations(db, &mapper, &index, &resolved, admin).await?;
    written.conversations_created = conversations.conversations_created;
    written.memberships += conversations.memberships;
    note_progress(db, job_id, &written).await?;

    let messages = run::import_messages(db, &mapper, archive, passphrase, &resolved).await?;
    written.messages_created = messages.messages_created;
    written.cancelled = messages.cancelled;
    note_progress(db, job_id, &written).await?;

    if written.cancelled {
        // Stopped on purpose, and everything written stays. Running the same archive again picks
        // up where this left off, because that is the same mechanism as resuming.
        //
        // The reading positions are laid down before leaving, even though the pass that normally
        // does it is further down: without this, everything imported so far arrives unread, and
        // somebody who stopped an import at eighty per cent is handed a workspace with thousands
        // of unread messages in conversations they had already read years ago.
        let positions = run::import_read_positions(db, &mapper, &index, &resolved).await?;
        written.read_positions = positions.read_positions;
        note_progress(db, job_id, &written).await?;
        run::finish_job(db, job_id, "cancelled").await?;
        return Ok(Outcome {
            written,
            limits: plan.limits,
        });
    }

    // Files come last of the data, because they are the only pass that can fail for a reason
    // nobody here controls, and everything before them is already safe on disk.
    if !index.files.is_empty() {
        let Some(storage) = storage else {
            finish(
                db,
                job_id,
                "failed",
                "this archive carries files and no object store is configured",
            )
            .await?;
            return Err(RunError::Storage(
                "this archive carries files and this instance has no object store configured"
                    .to_owned(),
            ));
        };
        let files = run::import_files(db, &mapper, storage, archive, passphrase, &resolved).await?;
        written.files_created = files.files_created;
        run::attach_files(db, &mapper, archive, passphrase, &resolved).await?;
        note_progress(db, job_id, &written).await?;
    }

    // Last, because a position points at a message.
    let positions = run::import_read_positions(db, &mapper, &index, &resolved).await?;
    written.read_positions = positions.read_positions;

    note_progress(db, job_id, &written).await?;
    run::finish_job(db, job_id, "completed").await?;

    Ok(Outcome {
        written,
        limits: plan.limits,
    })
}

/// What the instance already holds, as far as the plan is concerned.
async fn existing_state(db: &DatabaseConnection) -> Result<Existing, RunError> {
    use crate::entities::{spaces, users};

    let emails = users::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .map(|user| user.email)
        .collect();
    let space_names = spaces::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .map(|space| space.name)
        .collect();
    Ok(Existing {
        emails,
        space_names,
    })
}

async fn note_progress(
    db: &DatabaseConnection,
    job_id: Uuid,
    written: &Written,
) -> Result<(), RunError> {
    let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? else {
        return Ok(());
    };
    let mut model: import_jobs::ActiveModel = job.into();
    model.accounts_done = Set((written.accounts_created + written.accounts_matched) as i32);
    model.channels_done = Set(written.conversations_created as i32);
    model.messages_done = Set(written.messages_created as i32);
    model.files_done = Set(written.files_created as i32);
    model.update(db).await?;
    Ok(())
}

async fn finish(
    db: &DatabaseConnection,
    job_id: Uuid,
    status: &str,
    error: &str,
) -> Result<(), RunError> {
    let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? else {
        return Ok(());
    };
    let mut model: import_jobs::ActiveModel = job.into();
    model.status = Set(status.to_owned());
    // Written for the administrator who reads it, never an internal message passed through.
    model.error = Set(Some(error.to_owned()));
    model.update(db).await?;
    Ok(())
}

/// A small helper so the totals update reads as one thing rather than five.
trait TotalsExt {
    fn into_active_model_for_totals(self) -> import_jobs::ActiveModel;
}

impl TotalsExt for import_jobs::Model {
    fn into_active_model_for_totals(self) -> import_jobs::ActiveModel {
        self.into()
    }
}
