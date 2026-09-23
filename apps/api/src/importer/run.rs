//! Writing what the plan promised.
//!
//! Everything here is built on one rule: **an entity is written and its mapping row is written in
//! the same transaction, or neither is**. That is what makes an import of several gigabytes
//! survivable. It will fail halfway at some point, and when it does, a second run finds the
//! mappings of everything the first one wrote and skips them. Resuming and re-importing are the
//! same mechanism, not two features.
//!
//! Accounts and spaces are mapped **without** a space: neither lives inside one. A person is one
//! person on this instance, not one person per team, and a space is not inside a space. What is
//! scoped to a space (a conversation, a message, a file) carries one.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Statement,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::entities::{
    channel_members, channel_pins, channels, conversations, dm_conversations, dm_participants,
    file_versions, files, import_jobs, import_mappings, message_attachments, message_reactions,
    messages, read_cursors, space_members, spaces, user_saved_messages, users,
};

use super::archive::Index;
use super::plan::{AccountOutcome, Plan};

/// Where a run puts bytes, and how it makes an image previewable.
///
/// The two travel together because they answer one question: what happens to a file. Passing them
/// side by side down four call levels was one argument too many on functions that already carry
/// the database, the archive and its passphrase.
pub struct Blobs<'a, S: BlobSink> {
    pub store: &'a S,
    /// The longest side of a generated thumbnail, as the instance configures it for its uploads:
    /// an imported image and an uploaded one are the same kind of thing.
    pub thumbnail_max_px: u32,
}

pub const KIND_SPACE: &str = "space";
pub const KIND_USER: &str = "user";
pub const KIND_CHANNEL: &str = "channel";
pub const KIND_MESSAGE: &str = "message";
pub const KIND_FILE: &str = "file";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Written {
    pub accounts_created: usize,
    pub accounts_matched: usize,
    pub spaces_created: usize,
    pub spaces_filled: usize,
    pub memberships: usize,
    pub conversations_created: usize,
    /// Conversations that were already here under the same name and took the archive's history
    /// rather than being created beside it.
    pub conversations_filled: usize,
    pub messages_created: usize,
    pub read_positions: usize,
    pub files_created: usize,
    /// What each pass went through, whether it wrote it or found it already here. This is what the
    /// screen shows as progress. Counting only what was created made a resumed run look frozen:
    /// it walks past thousands of messages an earlier run brought over, and every counter stood at
    /// zero until the end, then jumped to "done".
    pub accounts_seen: usize,
    pub conversations_seen: usize,
    pub messages_seen: usize,
    pub files_seen: usize,
    /// Set when the administrator asked the job to stop and it did, at a boundary, keeping
    /// everything already written.
    pub cancelled: bool,
}

#[derive(Debug)]
pub enum RunError {
    Db(String),
    /// The object store refused or is unreachable. Kept apart from a database failure because the
    /// answer differs: a database error is ours to fix, a storage one is usually the operator's,
    /// and an import that cannot store bytes must stop rather than write file rows pointing at
    /// nothing.
    Storage(String),
    /// The instance cannot tell which row the archive means. Refusing is the only safe answer: the
    /// alternative is pouring someone's history into the wrong place.
    Ambiguous(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Db(message) | RunError::Ambiguous(message) => write!(f, "{message}"),
            RunError::Storage(message) => {
                write!(f, "the object store could not take the file: {message}")
            }
        }
    }
}

impl From<sea_orm::DbErr> for RunError {
    fn from(err: sea_orm::DbErr) -> Self {
        RunError::Db(err.to_string())
    }
}

type Result<T> = std::result::Result<T, RunError>;

/// Opens a job: the row an administrator watches, and the anchor every mapping points back to.
///
/// `space_id` is `None` when the archive brings its own spaces, which is the ordinary case. It
/// carries a space only when an administrator imports into one that already exists.
pub async fn start_job<C: ConnectionTrait>(
    db: &C,
    source: &str,
    created_by: Uuid,
    space_id: Option<Uuid>,
    // `options` carries what the administrator decided about the people, as JSON. Kept on the job
    // rather than in the request that started it, so a run resumed tomorrow makes the same
    // decisions about the same people.
    options: &str,
) -> Result<Uuid> {
    let job_id = Uuid::new_v4();
    import_jobs::ActiveModel {
        id: Set(job_id),
        space_id: Set(space_id),
        created_by: Set(Some(created_by)),
        source: Set(source.to_owned()),
        status: Set("running".to_owned()),
        options: Set(options.to_owned()),
        archive_file_id: Set(None),
        manifest: Set(None),
        channels_total: Set(0),
        channels_done: Set(0),
        messages_total: Set(0),
        messages_done: Set(0),
        files_total: Set(0),
        files_done: Set(0),
        accounts_total: Set(0),
        accounts_done: Set(0),
        error: Set(None),
        started_at: Set(Some(OffsetDateTime::now_utc())),
        finished_at: Set(None),
        created_at: NotSet,
        updated_at: NotSet,
    }
    .insert(db)
    .await?;
    Ok(job_id)
}

/// Forgets the correspondences whose row is no longer here.
///
/// A correspondence says "this identifier in the archive is that row here", and a resumed run
/// believes it: it skips what it recognises and hangs new rows off it. When the row has gone since
/// (the instance was replaced, a backup was restored, a space was deleted by hand), the belief is
/// false, and the first conversation hung off a vanished space fails on its foreign key, on every
/// run, for good. Checked at the start of every run, against the rows themselves, because nothing
/// in the table can say on its own that what it points at still exists.
///
/// The consequence is deliberate: something deleted here after an import comes back if the same
/// archive is run again. That is what running an archive means - make this instance hold what the
/// archive holds - and the alternative was an import that could never be run again at all.
pub async fn forget_vanished<C: ConnectionTrait>(db: &C) -> Result<u64> {
    let mut forgotten = 0;
    for (kind, table) in [
        (KIND_SPACE, "spaces"),
        (KIND_USER, "users"),
        (KIND_CHANNEL, "conversations"),
        (KIND_MESSAGE, "messages"),
        (KIND_FILE, "files"),
    ] {
        // The table name comes from the list above, never from input.
        let sql = format!(
            "DELETE FROM import_mappings m WHERE m.kind = $1 \
             AND NOT EXISTS (SELECT 1 FROM {table} t WHERE t.id = m.internal_id)"
        );
        let result = db
            .execute_raw(Statement::from_sql_and_values(
                db.get_database_backend(),
                sql,
                [kind.into()],
            ))
            .await?;
        forgotten += result.rows_affected();
    }
    Ok(forgotten)
}

/// Closes a job.
///
/// The counters are left as the passes wrote them. They used to be read back from this job's own
/// correspondences, on the grounds that a resumed run did part of its work elsewhere; but every run
/// walks the whole archive and counts what it went through, found or written, so its counters are
/// already whole. Reading them back from the job instead said "0 accounts" at the end of every
/// resumed import, whose accounts all belong to the job that first brought them over.
pub async fn finish_job<C: ConnectionTrait>(db: &C, job_id: Uuid, status: &str) -> Result<()> {
    let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? else {
        return Err(RunError::Db("the job disappeared while it ran".to_owned()));
    };

    let mut model: import_jobs::ActiveModel = job.into();
    model.status = Set(status.to_owned());
    model.finished_at = Set(Some(OffsetDateTime::now_utc()));
    model.update(db).await?;
    Ok(())
}

/// How many entities of one kind this job has mapped, across every run of it.
#[cfg(test)]
pub async fn written_so_far<C: ConnectionTrait>(db: &C, job_id: Uuid, kind: &str) -> Result<u64> {
    Ok(import_mappings::Entity::find()
        .filter(import_mappings::Column::JobId.eq(job_id))
        .filter(import_mappings::Column::Kind.eq(kind))
        .count(db)
        .await?)
}

/// What identifies one correspondence: a kind, the space it belongs to (none for the things that
/// are instance-wide), and the identifier the source spells.
type Correspondence = (String, Option<Uuid>, String);

/// Looks up what an earlier run already wrote, and records what this one writes.
///
/// **Every correspondence for this source is held in memory.** Asking the database each time cost
/// one query per message, one per author, one per person who reacted and two per reply: on an
/// archive of a hundred and twenty thousand messages that is well over half a million round trips
/// spent answering questions whose answers together weigh a few tens of megabytes. The table
/// remains the truth and every write still goes to it; this is a reader in front of it, filled
/// once and kept in step by `record`.
pub struct Mapper<'a> {
    pub job_id: Uuid,
    pub source: &'a str,
    /// Guarded rather than borrowed mutably: the passes hold the mapper by shared reference while
    /// awaiting, and the lock is never held across an await.
    seen: std::sync::Mutex<std::collections::HashMap<Correspondence, Uuid>>,
    /// Whether the whole table has been read for this source.
    ///
    /// Until it has, a miss means nothing and the question goes to the database. Only afterwards
    /// is an absence here an absence there. Without this distinction a caller that forgot to
    /// preload would be told, silently and wrongly, that nothing had ever been imported, and would
    /// import all of it a second time.
    complete: std::sync::atomic::AtomicBool,
    /// Set for an import run by somebody who does not administer the instance: the correspondences
    /// it reads and writes are that person's own (`import_mappings.owner_id`).
    ///
    /// Without it, an archive spelling the same source identifiers as an earlier import (anybody's)
    /// would resolve to that import's spaces and conversations, and write into them.
    owner: Option<Uuid>,
}

impl<'a> Mapper<'a> {
    pub fn new(job_id: Uuid, source: &'a str) -> Self {
        Self {
            job_id,
            source,
            seen: std::sync::Mutex::new(std::collections::HashMap::new()),
            complete: std::sync::atomic::AtomicBool::new(false),
            owner: None,
        }
    }

    /// Recognise only what `owner`'s own imports wrote. `None` keeps the whole instance in view,
    /// which is what an administrator's import does.
    pub fn scoped_to(mut self, owner: Option<Uuid>) -> Self {
        self.owner = owner;
        self
    }

    /// Whose imports this mapper is limited to, if anyone's.
    pub fn owner(&self) -> Option<Uuid> {
        self.owner
    }

    /// The mappings this mapper may see: this source's, in this mapper's namespace.
    fn visible(&self) -> sea_orm::Select<import_mappings::Entity> {
        let query =
            import_mappings::Entity::find().filter(import_mappings::Column::Source.eq(self.source));
        match self.owner {
            None => query.filter(import_mappings::Column::OwnerId.is_null()),
            Some(owner) => query.filter(import_mappings::Column::OwnerId.eq(owner)),
        }
    }

    /// Reads every correspondence this source already has, in one query.
    ///
    /// Filtered by source and not by job, deliberately: a second archive cut from the same source
    /// is the ordinary case, and what makes it cheap is finding the first run's work.
    pub async fn preload<C: ConnectionTrait>(&self, db: &C) -> Result<usize> {
        let rows = self.visible().all(db).await?;
        let mut seen = self.seen.lock().expect("mapper cache");
        for row in rows {
            seen.insert((row.kind, row.space_id, row.external_ref), row.internal_id);
        }
        self.complete
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(seen.len())
    }

    /// The row an earlier run created for this source identifier, if any.
    ///
    /// Answered from memory. `preload` has read the whole table for this source and `record` keeps
    /// what follows in step, so an absence here is an absence there.
    pub async fn resolve<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        external_ref: &str,
        space_id: Option<Uuid>,
    ) -> Result<Option<Uuid>> {
        let want: Correspondence = (kind.to_owned(), space_id, external_ref.to_owned());
        {
            let seen = self.seen.lock().expect("mapper cache");
            if let Some(found) = seen.get(&want) {
                return Ok(Some(*found));
            }
            if self.complete.load(std::sync::atomic::Ordering::Acquire) {
                return Ok(None);
            }
        }

        let mut query = self
            .visible()
            .filter(import_mappings::Column::Kind.eq(kind))
            .filter(import_mappings::Column::ExternalRef.eq(external_ref));
        query = match space_id {
            Some(space) => query.filter(import_mappings::Column::SpaceId.eq(space)),
            None => query.filter(import_mappings::Column::SpaceId.is_null()),
        };
        let found = query.one(db).await?.map(|row| row.internal_id);
        if let Some(id) = found {
            self.seen.lock().expect("mapper cache").insert(want, id);
        }
        Ok(found)
    }

    /// Records the correspondence. Called in the same transaction as the row it points at: a
    /// mapping written separately is a promise the database never made.
    pub async fn record<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        external_ref: &str,
        space_id: Option<Uuid>,
        internal_id: Uuid,
    ) -> Result<()> {
        import_mappings::ActiveModel {
            id: Set(Uuid::new_v4()),
            job_id: Set(self.job_id),
            space_id: Set(space_id),
            source: Set(self.source.to_owned()),
            kind: Set(kind.to_owned()),
            external_ref: Set(external_ref.to_owned()),
            internal_id: Set(internal_id),
            owner_id: Set(self.owner),
            created_at: NotSet,
        }
        .insert(db)
        .await?;
        // In step with the table, or the next pass would ask for something it just wrote and be
        // told it does not exist.
        self.seen.lock().expect("mapper cache").insert(
            (kind.to_owned(), space_id, external_ref.to_owned()),
            internal_id,
        );
        Ok(())
    }
}

/// Brings the accounts over.
///
/// A recognised address maps to the account that is already here and nothing is written to it: an
/// import does not get to rename people or change their settings.
///
/// Everyone else is created **waiting**: `pending`, with no password. That is not an incomplete
/// account, it is the shape the invitation flow claims later. The import places the person, their
/// spaces, their conversations and their history; they arrive into all of it when they accept.
pub async fn import_accounts<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    plan: &Plan,
) -> Result<Written> {
    let mut written = Written::default();

    for account in &plan.accounts {
        written.accounts_seen += 1;
        // Left out on purpose. Their messages still arrive, with no author: this was a decision
        // about people, and dropping their text as well would be a loss nobody asked for.
        if account.skipped {
            note_every(db, mapper.job_id, Counter::Accounts, written.accounts_seen).await?;
            continue;
        }
        if mapper
            .resolve(db, KIND_USER, &account.source_id, None)
            .await?
            .is_some()
        {
            // An earlier run already brought this person over.
            note_every(db, mapper.job_id, Counter::Accounts, written.accounts_seen).await?;
            continue;
        }

        let user_id = match account.outcome {
            AccountOutcome::Matched => {
                let existing = users::Entity::find()
                    .filter(users::Column::Email.eq(account.email.to_lowercase()))
                    .one(db)
                    .await?;
                match existing {
                    Some(user) => {
                        written.accounts_matched += 1;
                        user.id
                    }
                    // The plan said this address was known and it is not any more: someone deleted
                    // the account between the plan and the run. Creating it is the safe answer,
                    // and it keeps the messages attributed to a person rather than to nobody.
                    None => create_waiting_account(db, account, &mut written).await?,
                }
            }
            AccountOutcome::Invited | AccountOutcome::NeedsDecision => {
                create_waiting_account(db, account, &mut written).await?
            }
        };

        mapper
            .record(db, KIND_USER, &account.source_id, None, user_id)
            .await?;
        note_every(db, mapper.job_id, Counter::Accounts, written.accounts_seen).await?;
    }
    note_done(db, mapper.job_id, Counter::Accounts, written.accounts_seen).await?;

    Ok(written)
}

/// The domain an account with no address is given one under.
///
/// The column is unique and not null, so somebody the archive carried without an address still
/// needs one. `.invalid` is reserved by RFC 2606 precisely for this: it resolves nowhere, so
/// nothing can be sent to it by accident. Everything that asks "can this person be written to?"
/// asks [`unreachable`] rather than testing for an empty string.
pub const NO_ADDRESS_DOMAIN: &str = "@import.invalid";

/// Whether an address can be written to at all.
pub fn unreachable(email: &str) -> bool {
    let email = email.trim();
    email.is_empty() || email.ends_with(NO_ADDRESS_DOMAIN)
}

async fn create_waiting_account<C: ConnectionTrait>(
    db: &C,
    account: &super::plan::AccountPlan,
    written: &mut Written,
) -> Result<Uuid> {
    let user_id = Uuid::new_v4();
    // An account with no address still has to have one: the column is unique and not null. It gets
    // one that cannot receive mail and cannot collide, and the plan has already told the
    // administrator that this person needs an address typed in or a link handed over.
    let email = if account.email.is_empty() {
        format!(
            "{}+{}{NO_ADDRESS_DOMAIN}",
            account.source_id,
            user_id.simple()
        )
    } else {
        account.email.to_lowercase()
    };
    users::ActiveModel {
        id: Set(user_id),
        email: Set(email),
        display_name: Set(account.display_name.clone()),
        // No password: this is what the invitation claims later, and what makes the account
        // unusable until its person arrives.
        password_hash: Set(None),
        status: Set(if account.active {
            "pending"
        } else {
            "disabled"
        }
        .to_owned()),
        mfa_enforced: Set(false),
        is_instance_admin: Set(false),
        locale: NotSet,
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
    .insert(db)
    .await?;
    written.accounts_created += 1;
    Ok(user_id)
}

/// Brings the spaces over, and puts the administrator who ran the import at the head of each one
/// it creates.
///
/// A space that already carries the archive's name is filled rather than duplicated: re-running an
/// import must not leave an instance with two "Atelier".
pub async fn import_spaces<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    index: &Index,
    owner: Uuid,
) -> Result<(Written, Vec<(String, Uuid)>)> {
    let mut written = Written::default();
    let mut resolved = Vec::new();

    for space in &index.spaces {
        if let Some(existing) = mapper.resolve(db, KIND_SPACE, &space.id, None).await? {
            // A scoped import resumes only into a space its importer still runs: having created it
            // once is not a standing right to write into it after being demoted or removed.
            if let Some(importer) = mapper.owner() {
                let runs_it = space_members::Entity::find_by_id((existing, importer))
                    .one(db)
                    .await?
                    .is_some_and(|member| matches!(member.role.as_str(), "owner" | "admin"));
                if !runs_it {
                    return Err(RunError::Ambiguous(format!(
                        "an earlier import brought {} over, and you no longer administer that space",
                        space.name
                    )));
                }
            }
            resolved.push((space.id.clone(), existing));
            continue;
        }

        // A scoped import never adopts a space it did not create: the name is somebody else's.
        if mapper.owner().is_some() {
            let id = create_space(db, &space.name, owner).await?;
            written.spaces_created += 1;
            written.memberships += 1;
            mapper.record(db, KIND_SPACE, &space.id, None, id).await?;
            resolved.push((space.id.clone(), id));
            continue;
        }

        // Names are not unique here: only the address is. So this looks at every space carrying the
        // name, and refuses to guess when there is more than one. Filling whichever row the
        // database happened to return would pour a company's history into the wrong space, and
        // nobody would find out until someone opened it.
        let by_name = spaces::Entity::find()
            .filter(spaces::Column::Name.eq(space.name.clone()))
            .all(db)
            .await?;

        let space_id = match by_name.len() {
            1 => {
                written.spaces_filled += 1;
                by_name[0].id
            }
            0 => {
                let id = create_space(db, &space.name, owner).await?;
                written.spaces_created += 1;
                written.memberships += 1;
                id
            }
            several => {
                return Err(RunError::Ambiguous(format!(
                    "{several} spaces here are already called {}: say which one the import should \
                     fill, or rename them",
                    space.name
                )))
            }
        };

        // Recorded at instance level, like an account: a space is not inside a space. Anything
        // scoped to a space (a conversation, a message, a file) carries one; these two do not.
        mapper
            .record(db, KIND_SPACE, &space.id, None, space_id)
            .await?;
        resolved.push((space.id.clone(), space_id));
    }

    Ok((written, resolved))
}

/// Creates the space itself, with no starting channel.
///
/// The ordinary creation path opens a "general" channel so a new space is not an empty room. An
/// imported space is not empty: it gets exactly the conversations the archive carries, and adding
/// one nobody asked for would be the same furniture this chain strips out of every source.
async fn create_space<C: ConnectionTrait>(db: &C, name: &str, owner: Uuid) -> Result<Uuid> {
    let space_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    // Slugs are unique across the instance and are checked against the history, not against the
    // spaces in use: an address a renamed space used to answer to still resolves to it, so handing
    // it to an imported space would hijack every link ever shared for the old one.
    let slug = crate::messaging::spaces::unique_slug(db, &crate::messaging::slug::slugify(name))
        .await
        .map_err(|_| {
            RunError::Db(format!(
                "too many spaces are already called {name}: the imported one needs another name"
            ))
        })?;

    let slug_for_history = slug.clone();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(name.to_owned()),
        slug: Set(slug.clone()),
        created_by: Set(Some(owner)),
        icon_key: Set(None),
        default_channel_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;

    // Recorded after the space exists: the address history points at `spaces.id`, and the other
    // order fails on a foreign key.
    crate::messaging::spaces::remember_slug(db, space_id, &slug_for_history)
        .await
        .map_err(|_| RunError::Db("could not record the space's address".to_owned()))?;

    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(owner),
        role: Set("owner".to_owned()),
        invited_by: Set(None),
        joined_at: Set(now),
    }
    .insert(db)
    .await?;

    Ok(space_id)
}

/// Brings the conversations over, with the people in them.
///
/// This is the half that makes an import feel like a migration rather than a data dump: someone who
/// accepts their invitation opens the product and finds the channels they were in, with the people
/// they were there with. Membership is written now, not when they sign in, so the workspace is
/// complete before anybody arrives in it.
///
/// A conversation is scoped to its space, so its mapping carries one, unlike an account or a space.
pub async fn import_conversations<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    index: &Index,
    spaces_by_source: &[(String, Uuid)],
    creator: Uuid,
) -> Result<Written> {
    let mut written = Written::default();

    for channel in &index.channels {
        written.conversations_seen += 1;
        let Some((_, space_id)) = spaces_by_source.iter().find(|(id, _)| id == &channel.space)
        else {
            // The checks refuse an archive whose conversation names a space it does not carry, so
            // reaching this means the space was skipped on purpose. Skipping its conversations is
            // the only coherent answer.
            continue;
        };
        let space_id = *space_id;

        if mapper
            .resolve(db, KIND_CHANNEL, &channel.id, Some(space_id))
            .await?
            .is_some()
        {
            note_every(
                db,
                mapper.job_id,
                Counter::Conversations,
                written.conversations_seen,
            )
            .await?;
            continue;
        }

        // Members first, resolved through their mappings: an account the import skipped cannot be
        // put in a room, and silently inventing one would be worse than leaving them out.
        let mut members = Vec::new();
        for source_id in &channel.members {
            if let Some(user_id) = mapper.resolve(db, KIND_USER, source_id, None).await? {
                members.push((source_id.clone(), user_id));
            }
        }

        let now = OffsetDateTime::now_utc();

        // A channel name is unique within its space, and an import that fills an existing space
        // walks straight into that: nearly every instance already has a "general", and so does
        // nearly every archive. Creating it again is impossible, so the history goes into the one
        // that is already there - the same answer the spaces pass gives to a space of the same
        // name, for the same reason.
        let adopted = if channel.kind == "direct" {
            None
        } else {
            adoptable(
                db,
                mapper,
                space_id,
                &crate::messaging::slug::slugify(&channel.name),
            )
            .await?
        };

        // An adopted conversation is written about no further: it belongs to this instance, which
        // is the only thing that knows what it is for, so its name, its topic and its kind stay as
        // the people using it left them. Only its history and its members grow.
        let conversation_id = if let Some(existing) = adopted {
            written.conversations_filled += 1;
            existing
        } else {
            let conversation_id = Uuid::new_v4();
            conversations::ActiveModel {
                id: Set(conversation_id),
                space_id: Set(space_id),
                kind: Set(channel.kind.clone()),
                created_at: Set(now),
            }
            .insert(db)
            .await?;
            written.conversations_created += 1;
            conversation_id
        };

        if adopted.is_some() {
            // Nothing to insert: the row is already here, and it is not this import's to reshape.
        } else if channel.kind == "direct" {
            dm_conversations::ActiveModel {
                id: Set(conversation_id),
                space_id: Set(space_id),
                is_group: Set(members.len() > 2),
                created_by: Set(Some(creator)),
                created_at: Set(now),
            }
            .insert(db)
            .await?;
        } else {
            channels::ActiveModel {
                id: Set(conversation_id),
                space_id: Set(space_id),
                // Free rather than exact: two conversations of one archive can carry names that
                // come down to the same one here ("Café" and "cafe"), and they are two rooms, so
                // they stay two rooms.
                name: Set(free_name(
                    db,
                    space_id,
                    &crate::messaging::slug::slugify(&channel.name),
                )
                .await?),
                // An archived conversation arrives archived: it is read-only here, which is the
                // closest thing to what it was there, and nobody has to tidy it up again.
                channel_type: Set(if channel.archived {
                    "archived".to_owned()
                } else {
                    channel.visibility.clone()
                }),
                topic: Set(if channel.topic.is_empty() {
                    None
                } else {
                    Some(channel.topic.clone())
                }),
                created_by: Set(Some(creator)),
                archived_at: Set(channel.archived.then_some(now)),
                // Provenance, on the row itself: where this conversation came from, readable
                // without joining anything.
                imported_source: Set(Some(mapper.source.to_owned())),
                external_ref: Set(Some(channel.id.clone())),
                position: Set(None),
                created_at: Set(now),
            }
            .insert(db)
            .await?;
        }

        for (source_id, user_id) in &members {
            // Being in a conversation means being in its space: an import that forgets this leaves
            // people in rooms of a workspace they are not part of.
            if space_members::Entity::find_by_id((space_id, *user_id))
                .one(db)
                .await?
                .is_none()
            {
                space_members::ActiveModel {
                    space_id: Set(space_id),
                    user_id: Set(*user_id),
                    role: Set("member".to_owned()),
                    invited_by: Set(None),
                    joined_at: Set(now),
                }
                .insert(db)
                .await?;
                written.memberships += 1;
            }

            let favourite = channel
                .member_state
                .iter()
                .any(|state| &state.user == source_id && state.favorite);

            if channel.kind == "direct" {
                dm_participants::ActiveModel {
                    dm_id: Set(conversation_id),
                    user_id: Set(*user_id),
                    notification_level: Set("all".to_owned()),
                    muted: Set(false),
                    hidden: Set(false),
                    added_at: Set(now),
                }
                .insert(db)
                .await?;
            } else if channel_members::Entity::find_by_id((conversation_id, *user_id))
                .one(db)
                .await?
                .is_none()
            {
                // Somebody can already be in a channel this import adopted, and their place in it
                // is theirs: joined when they joined, with the notification level they chose.
                channel_members::ActiveModel {
                    channel_id: Set(conversation_id),
                    user_id: Set(*user_id),
                    role: Set("member".to_owned()),
                    notification_level: Set("all".to_owned()),
                    muted: Set(false),
                    favorite: Set(favourite),
                    joined_at: Set(now),
                }
                .insert(db)
                .await?;
            }
        }

        mapper
            .record(
                db,
                KIND_CHANNEL,
                &channel.id,
                Some(space_id),
                conversation_id,
            )
            .await?;
        note_every(
            db,
            mapper.job_id,
            Counter::Conversations,
            written.conversations_seen,
        )
        .await?;
    }
    note_done(
        db,
        mapper.job_id,
        Counter::Conversations,
        written.conversations_seen,
    )
    .await?;

    Ok(written)
}

/// Which channels each space here already has: its space's name, and its own handle.
///
/// Read for the plan, so that a space the import fills can say which of its conversations are
/// already here and will take the archive's history rather than being created. Keyed by name on
/// both sides because that is what the run itself matches on, and a plan that promised anything
/// else would be a plan of a different import.
pub async fn existing_channels<C: ConnectionTrait>(
    db: &C,
) -> std::result::Result<Vec<(String, String)>, sea_orm::DbErr> {
    let names: std::collections::HashMap<Uuid, String> = spaces::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .map(|space| (space.id, space.name))
        .collect();
    Ok(channels::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .filter_map(|channel| {
            names
                .get(&channel.space_id)
                .map(|space| (space.clone(), channel.name))
        })
        .collect())
}

/// The channel of that name this import may pour its history into, if there is one.
///
/// A name is unique within a space, so an archive's "general" landing in a space that already has
/// one has two possible answers: fail, which is what it did, or put the history where the name
/// already points. It goes where the name points, which is also what the reader expects: they
/// opened #general and their old messages are in it.
///
/// One exception, and it is the reason this asks rather than just looking the name up: a channel
/// **this source already claimed** is not free to be claimed again. Two conversations of one
/// archive can come down to the same name here, and they are two rooms in the source; merging them
/// would mix two histories that nobody could ever separate again.
async fn adoptable<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    space_id: Uuid,
    name: &str,
) -> Result<Option<Uuid>> {
    let Some(existing) = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .filter(channels::Column::Name.eq(name.to_owned()))
        .one(db)
        .await?
    else {
        return Ok(None);
    };

    let claimed = import_mappings::Entity::find()
        .filter(import_mappings::Column::Source.eq(mapper.source.to_owned()))
        .filter(import_mappings::Column::Kind.eq(KIND_CHANNEL))
        .filter(import_mappings::Column::InternalId.eq(existing.id))
        .one(db)
        .await?
        .is_some();

    Ok((!claimed).then_some(existing.id))
}

/// A name no channel of this space answers to yet.
///
/// Only ever reached for a conversation that cannot be adopted, so the suffix marks a genuine
/// collision rather than a channel meeting itself.
async fn free_name<C: ConnectionTrait>(db: &C, space_id: Uuid, base: &str) -> Result<String> {
    for suffix in 1..=50u32 {
        let candidate = if suffix == 1 {
            base.to_owned()
        } else {
            format!("{base}-{suffix}")
        };
        let taken = channels::Entity::find()
            .filter(channels::Column::SpaceId.eq(space_id))
            .filter(channels::Column::Name.eq(candidate.clone()))
            .one(db)
            .await?
            .is_some();
        if !taken {
            return Ok(candidate);
        }
    }
    Err(RunError::Ambiguous(format!(
        "too many channels of this space are already called {base}: the imported one needs another \
         name"
    )))
}

/// Whether the administrator has asked this job to stop.
///
/// Checked at conversation boundaries rather than per message: a query per message would cost more
/// than the import, and "stop at the next conversation" is a promise anyone can understand, where
/// "stop within thirty seconds" is not.
pub async fn cancellation_asked<C: ConnectionTrait>(db: &C, job_id: Uuid) -> Result<bool> {
    Ok(import_jobs::Entity::find_by_id(job_id)
        .one(db)
        .await?
        .is_some_and(|job| job.status == "cancelling" || job.status == "cancelled"))
}

/// Brings the messages over.
///
/// Read straight from the archive rather than from anything held in memory: there can be millions,
/// and only one is ever needed at a time.
///
/// **An import is silent.** These rows are written without a notification, an unread count or a
/// mention alert. Ten thousand imported messages must not wake ten people's phones about
/// conversations they had months ago somewhere else.
///
/// Threads are resolved in a second pass. A reply can appear before its root in the file, and
/// refusing that would make the import depend on a producer's ordering rather than on the contract.
/// Which of a job's counters a pass is filling in as it goes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Counter {
    Accounts,
    Conversations,
    Messages,
    Files,
}

impl Counter {
    /// How often this pass writes down where it is.
    ///
    /// Tuned to the pass and not to the database: a hundred messages is nothing next to the work
    /// between them, while four hundred conversations reported once at the end is a bar that never
    /// moved at all. The cost is one small update, and a screen that says nothing for four minutes
    /// costs more.
    fn step(self) -> usize {
        match self {
            Counter::Messages => 100,
            // One file can take seconds to store; five of them were a long silence on screen.
            Counter::Files => 1,
            _ => 5,
        }
    }
}

/// Writes a running count where the screen can read it.
async fn note_done<C: ConnectionTrait>(
    db: &C,
    job_id: Uuid,
    counter: Counter,
    done: usize,
) -> Result<()> {
    let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? else {
        return Ok(());
    };
    let mut model: import_jobs::ActiveModel = job.into();
    match counter {
        Counter::Accounts => model.accounts_done = Set(done as i32),
        Counter::Conversations => model.channels_done = Set(done as i32),
        Counter::Messages => model.messages_done = Set(done as i32),
        Counter::Files => model.files_done = Set(done as i32),
    }
    model.update(db).await?;
    Ok(())
}

/// Reports every `step` items, so a caller writes one line rather than three.
async fn note_every<C: ConnectionTrait>(
    db: &C,
    job_id: Uuid,
    counter: Counter,
    done: usize,
) -> Result<()> {
    if done.is_multiple_of(counter.step()) {
        note_done(db, job_id, counter, done).await?;
    }
    Ok(())
}

pub async fn import_messages<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    spaces_by_source: &[(String, Uuid)],
) -> Result<Written> {
    let mut written = Written::default();
    let mut pending: Vec<(String, String)> = Vec::new();

    // Collected first: a message needs its conversation, and resolving one per message would be a
    // query each time for something that changes rarely.
    let mut conversation_of: std::collections::HashMap<String, (Uuid, Uuid, String)> =
        std::collections::HashMap::new();
    let index =
        super::archive::index(archive, passphrase).map_err(|e| RunError::Db(e.to_string()))?;
    for channel in &index.channels {
        let Some((_, space_id)) = spaces_by_source.iter().find(|(id, _)| id == &channel.space)
        else {
            continue;
        };
        if let Some(conversation) = mapper
            .resolve(db, KIND_CHANNEL, &channel.id, Some(*space_id))
            .await?
        {
            conversation_of.insert(
                channel.id.clone(),
                (conversation, *space_id, channel.kind.clone()),
            );
        }
    }

    // What a mention has to become. The archive spells one as `@` and the person's identifier at
    // the source, which is the only thing a producer can know; the product resolves a mention
    // against a display name. Translating happens here, once the accounts are in hand, because
    // nowhere later is the source identifier still readable.
    //
    // The display name as its owner writes it, spaces included: `@` followed by a whole display
    // name is what the composer writes, what `resolve_mentions` looks for first, and what the
    // reader recognises. Squeezing the spaces out produced `@ThéoVilain` under a message from
    // somebody whose name is Théo Vilain, which is nobody's name.
    let handles: std::collections::HashMap<String, String> = index
        .users
        .iter()
        .filter_map(|user| {
            let handle = user
                .display_name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!handle.is_empty()).then(|| (user.id.clone(), handle))
        })
        .collect();

    let mut records = Vec::new();
    super::archive::walk(archive, passphrase, |member| {
        if let super::archive::Member::Message(message) = member {
            records.push(message);
        }
        Ok(())
    })
    .map_err(|e| RunError::Db(e.to_string()))?;

    let mut current_channel: Option<&str> = None;
    for record in &records {
        // A cancellation stops here, between two conversations, and keeps everything already
        // written: an import that undid its own work on the way out would turn a change of mind
        // into an afternoon lost.
        if current_channel != Some(record.channel.as_str()) {
            current_channel = Some(record.channel.as_str());
            if cancellation_asked(db, mapper.job_id).await? {
                written.cancelled = true;
                break;
            }
        }

        written.messages_seen += 1;
        let Some((conversation_id, space_id, kind)) = conversation_of.get(&record.channel) else {
            continue;
        };
        if mapper
            .resolve(db, KIND_MESSAGE, &record.id, Some(*space_id))
            .await?
            .is_some()
        {
            note_every(db, mapper.job_id, Counter::Messages, written.messages_seen).await?;
            continue;
        }

        let author = match &record.author {
            Some(source_id) => mapper.resolve(db, KIND_USER, source_id, None).await?,
            None => None,
        };
        let message_id = Uuid::new_v4();
        let sent_at = parse_instant(&record.sent_at);

        messages::ActiveModel {
            id: Set(message_id),
            conversation_id: Set(*conversation_id),
            // A message whose author matched nothing keeps its text and arrives with no author,
            // which the interface already renders as an absent person. Dropping it would be the
            // silent loss this whole chain exists to prevent.
            author_id: Set(author),
            kind: Set(if record.system_event.is_some() {
                "system".to_owned()
            } else {
                "message".to_owned()
            }),
            body: Set(rewrite_mentions(&record.body, &handles)),
            system_event: Set(record.system_event.clone()),
            // Filled by the second pass, once every root has an identifier here.
            parent_message_id: Set(None),
            reply_count: Set(0),
            imported_source: Set(Some(mapper.source.to_owned())),
            external_ref: Set(Some(record.id.clone())),
            created_at: Set(sent_at),
            edited_at: Set(record.edited_at.as_deref().map(parse_instant)),
            deleted_at: Set(None),
        }
        .insert(db)
        .await?;
        mapper
            .record(db, KIND_MESSAGE, &record.id, Some(*space_id), message_id)
            .await?;
        written.messages_created += 1;

        for reaction in &record.reactions {
            for source_id in &reaction.by {
                if let Some(user_id) = mapper.resolve(db, KIND_USER, source_id, None).await? {
                    message_reactions::ActiveModel {
                        message_id: Set(message_id),
                        user_id: Set(user_id),
                        emoji: Set(reaction.emoji.clone()),
                        created_at: Set(sent_at),
                    }
                    .insert(db)
                    .await?;
                }
            }
        }

        for source_id in &record.saved_by {
            if let Some(user_id) = mapper.resolve(db, KIND_USER, source_id, None).await? {
                user_saved_messages::ActiveModel {
                    user_id: Set(user_id),
                    message_id: Set(message_id),
                    saved_at: Set(sent_at),
                }
                .insert(db)
                .await?;
            }
        }

        // Only a channel has pins: a direct conversation has no pinned panel to put one in.
        if record.pinned && kind != "direct" {
            channel_pins::ActiveModel {
                channel_id: Set(*conversation_id),
                message_id: Set(message_id),
                pinned_by: Set(author),
                pinned_at: Set(sent_at),
            }
            .insert(db)
            .await?;
        }

        if let Some(root) = &record.thread_root {
            pending.push((record.id.clone(), root.clone()));
        }

        // Said out loud while it happens, not once at the end. The messages pass is the long one:
        // on a real migration it runs for many minutes, and a bar that sits at zero throughout is
        // indistinguishable from one that has crashed.
        note_every(db, mapper.job_id, Counter::Messages, written.messages_seen).await?;
    }
    note_done(db, mapper.job_id, Counter::Messages, written.messages_seen).await?;

    attach_threads(db, mapper, &pending, spaces_by_source, &conversation_of).await?;
    Ok(written)
}

/// How many replies go into one statement: well under PostgreSQL's limit of 65 535 parameters
/// (two per reply), and large enough that a big workspace is a few dozen statements.
const THREAD_BATCH: usize = 1000;

/// The second pass: hangs every reply on its root, now that both exist here.
async fn attach_threads<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    pending: &[(String, String)],
    _spaces: &[(String, Uuid)],
    conversation_of: &std::collections::HashMap<String, (Uuid, Uuid, String)>,
) -> Result<()> {
    let spaces: Vec<Uuid> = {
        let mut seen: Vec<Uuid> = conversation_of
            .values()
            .map(|(_, space, _)| *space)
            .collect();
        seen.sort();
        seen.dedup();
        seen
    };

    // Resolved from memory first: the mapper holds every correspondence of this source.
    let mut pairs: Vec<(Uuid, Uuid)> = Vec::with_capacity(pending.len());
    for (reply_ref, root_ref) in pending {
        let mut reply = None;
        let mut root = None;
        for space_id in &spaces {
            if reply.is_none() {
                reply = mapper
                    .resolve(db, KIND_MESSAGE, reply_ref, Some(*space_id))
                    .await?;
            }
            if root.is_none() {
                root = mapper
                    .resolve(db, KIND_MESSAGE, root_ref, Some(*space_id))
                    .await?;
            }
        }
        // The checks refuse an archive whose reply names a root it does not carry, so a miss can
        // only mean the root was in a conversation left behind. The reply keeps its text and simply
        // stops being a reply, rather than pointing at nothing.
        if let (Some(reply_id), Some(root_id)) = (reply, root) {
            pairs.push((reply_id, root_id));
        }
    }

    // Then written in batches. One reply at a time was four round trips each - read the reply,
    // write it, read the root, write its count - and a workspace has thousands of replies: 5 900
    // of them took twenty seconds, with the screen already showing the next pass at zero.
    let backend = db.get_database_backend();
    for chunk in pairs.chunks(THREAD_BATCH) {
        let rows: Vec<String> = (0..chunk.len())
            .map(|i| format!("(${}::uuid, ${}::uuid)", 2 * i + 1, 2 * i + 2))
            .collect();
        let values: Vec<sea_orm::Value> = chunk
            .iter()
            .flat_map(|(reply, root)| [(*reply).into(), (*root).into()])
            .collect();
        db.execute_raw(Statement::from_sql_and_values(
            backend,
            format!(
                "UPDATE messages m SET parent_message_id = v.root \
                 FROM (VALUES {}) AS v(reply, root) WHERE m.id = v.reply",
                rows.join(", ")
            ),
            values,
        ))
        .await?;
    }

    // The root carries the count the interface reads. Counted rather than incremented: a resumed
    // run finds some replies already attached, and a count is right whatever came before. Every
    // reply counts, a withdrawn one too, which is what sending one does elsewhere.
    let mut roots: Vec<Uuid> = pairs.iter().map(|(_, root)| *root).collect();
    roots.sort();
    roots.dedup();
    for chunk in roots.chunks(THREAD_BATCH) {
        let slots: Vec<String> = (1..=chunk.len()).map(|i| format!("${i}::uuid")).collect();
        let values: Vec<sea_orm::Value> = chunk.iter().map(|root| (*root).into()).collect();
        db.execute_raw(Statement::from_sql_and_values(
            backend,
            format!(
                "UPDATE messages r SET reply_count = c.n \
                 FROM (SELECT parent_message_id AS id, count(*)::int AS n FROM messages \
                       WHERE parent_message_id IN ({}) GROUP BY parent_message_id) AS c \
                 WHERE r.id = c.id",
                slots.join(", ")
            ),
            values,
        ))
        .await?;
    }
    Ok(())
}

/// The archive spells every instant the same way, and the checks refused the archive if it did not.
fn parse_instant(value: &str) -> OffsetDateTime {
    time::PrimitiveDateTime::parse(
        value,
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z"),
    )
    .map(|parsed| parsed.assume_utc())
    .unwrap_or_else(|_| OffsetDateTime::now_utc())
}

/// Puts everyone back where they had read up to.
///
/// Small, and the sort of thing a migrating team notices on the first morning: without it every
/// conversation opens screaming with months of unread history, and the first thing anybody does is
/// mark everything read, which throws away the one piece of state that made the workspace theirs.
///
/// A source spells the position in whichever way it holds it. Nextcloud names the last message
/// read, which needs no guessing. Mattermost only knows a moment, so the position becomes the last
/// message sent at or before it: the closest true statement a timestamp allows.
///
/// A position naming a message that never crossed is moved back to the nearest one we hold. Marking
/// a whole conversation unread over one missing identifier would be worse than being slightly
/// early.
pub async fn import_read_positions<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    index: &Index,
    spaces_by_source: &[(String, Uuid)],
) -> Result<Written> {
    let mut written = Written::default();

    for channel in &index.channels {
        let Some((_, space_id)) = spaces_by_source.iter().find(|(id, _)| id == &channel.space)
        else {
            continue;
        };
        let Some(conversation_id) = mapper
            .resolve(db, KIND_CHANNEL, &channel.id, Some(*space_id))
            .await?
        else {
            continue;
        };

        for state in &channel.member_state {
            let Some(user_id) = mapper.resolve(db, KIND_USER, &state.user, None).await? else {
                continue;
            };

            let last_read = match (&state.read_message, &state.read_at) {
                (Some(source_id), _) => {
                    match mapper
                        .resolve(db, KIND_MESSAGE, source_id, Some(*space_id))
                        .await?
                    {
                        Some(message_id) => Some(message_id),
                        // The message did not cross: fall back to the moment it was sent, which we
                        // do not have either, so to the last message in the conversation. Being
                        // slightly early beats declaring months of history unread.
                        None => last_message_before(db, conversation_id, None).await?,
                    }
                }
                (None, Some(moment)) => {
                    last_message_before(db, conversation_id, Some(parse_instant(moment))).await?
                }
                (None, None) => continue,
            };

            if last_read.is_none() {
                continue;
            }
            if read_cursors::Entity::find_by_id((conversation_id, user_id))
                .one(db)
                .await?
                .is_some()
            {
                continue;
            }

            read_cursors::ActiveModel {
                conversation_id: Set(conversation_id),
                user_id: Set(user_id),
                last_read_message_id: Set(last_read),
                updated_at: Set(OffsetDateTime::now_utc()),
            }
            .insert(db)
            .await?;
            written.read_positions += 1;
        }
    }

    Ok(written)
}

/// The last message of a conversation at or before an instant, or simply the last one.
async fn last_message_before<C: ConnectionTrait>(
    db: &C,
    conversation_id: Uuid,
    moment: Option<OffsetDateTime>,
) -> Result<Option<Uuid>> {
    let mut query =
        messages::Entity::find().filter(messages::Column::ConversationId.eq(conversation_id));
    if let Some(moment) = moment {
        query = query.filter(messages::Column::CreatedAt.lte(moment));
    }
    Ok(query
        .order_by_desc(messages::Column::CreatedAt)
        .one(db)
        .await?
        .map(|message| message.id))
}

/// Where an imported file's bytes go.
///
/// A seam of four lines, and only the importer has it: the object store is the one thing in an
/// import that can fail for a reason nobody here controls, and the whole point of the ordering
/// below is that it be tested, including the failure. A test drives an in-memory sink and one that
/// refuses; production hands over the real store.
#[allow(async_fn_in_trait)]
pub trait BlobSink {
    async fn put(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> std::result::Result<(), String>;
}

impl BlobSink for crate::storage::S3Store {
    async fn put(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> std::result::Result<(), String> {
        crate::storage::S3Store::put(self, key, bytes, content_type)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Brings the files over, bytes and all.
///
/// The only part of an import that leaves the database, and the only one that can fail for a reason
/// nobody here controls. So the order is deliberate: the bytes are stored **first**, and the rows
/// that point at them are written after. A row written first would survive a storage failure and
/// leave a file that exists, has a name and a size, and cannot be opened; the other way round, a
/// failure leaves an orphan object, which costs space and lies to nobody.
///
/// A blob is written once even when several accounts held the same file: the archive already
/// deduplicated by digest, and so does this.
///
/// This form reads the file records itself, which only the tests need: they start from an archive
/// and nothing else. The run already holds the records and goes through [`import_files_from`].
#[cfg(test)]
pub async fn import_files<C: ConnectionTrait, S: BlobSink>(
    db: &C,
    mapper: &Mapper<'_>,
    blobs: &Blobs<'_, S>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    spaces_by_source: &[(String, Uuid)],
) -> Result<Written> {
    let index =
        super::archive::index(archive, passphrase).map_err(|e| RunError::Db(e.to_string()))?;
    import_files_from(
        db,
        mapper,
        blobs,
        archive,
        passphrase,
        spaces_by_source,
        &index.files,
    )
    .await
}

/// The same pass, for a caller that has already read the file records.
///
/// The run has: it read the whole archive to check it before anything was written. Reading it all
/// again only to learn the same records back, hashing every byte of every file on the way, was
/// minutes of an import sitting at "0 files" on a real migration.
///
/// **The bytes stream.** The archive is read on a thread of its own, and each file it carries is
/// handed over as it comes, stored, described and counted, before the next one is read. The first
/// version read every file into memory before writing any: the counter stood at zero for the whole
/// read and then jumped to the end, and a migration with sixty gigabytes of attachments needed
/// sixty gigabytes of memory to get there. A small queue sits between the two sides, so reading
/// keeps a little ahead of storing and no more.
pub async fn import_files_from<C: ConnectionTrait, S: BlobSink>(
    db: &C,
    mapper: &Mapper<'_>,
    blobs: &Blobs<'_, S>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    spaces_by_source: &[(String, Uuid)],
    records: &[super::archive::FileRecord],
) -> Result<Written> {
    let mut written = Written::default();

    // A file belongs to the space its conversation is in, and to the first space of the archive
    // when it belongs to no conversation: an account's files are not scoped to a room.
    let Some((_, default_space)) = spaces_by_source.first() else {
        return Ok(written);
    };
    let space_id = *default_space;

    // What is left to do, by the digest of its bytes. A resumed run does not read again the bytes
    // of the files it already stored, and two records sharing one blob are served by one read.
    let mut pending: std::collections::HashMap<String, Vec<&super::archive::FileRecord>> =
        std::collections::HashMap::new();
    for file in records {
        if mapper
            .resolve(db, KIND_FILE, &file.id, Some(space_id))
            .await?
            .is_some()
        {
            written.files_seen += 1;
            continue;
        }
        let Some(digest) = file.hash.strip_prefix("sha256:") else {
            written.files_seen += 1;
            continue;
        };
        pending.entry(digest.to_owned()).or_default().push(file);
    }
    // Said before the first byte is read: on a resumed run, most of the files may be here already.
    note_done(db, mapper.job_id, Counter::Files, written.files_seen).await?;

    if !pending.is_empty() {
        let wanted: std::collections::HashSet<String> = pending.keys().cloned().collect();
        let (sender, mut received) = tokio::sync::mpsc::channel::<(String, Vec<u8>)>(4);
        let path = archive.to_path_buf();
        let secret = passphrase.map(str::to_owned);
        let reading = tokio::task::spawn_blocking(move || {
            super::archive::walk(&path, secret.as_deref(), |member| {
                if let super::archive::Member::Blob { digest, reader } = member {
                    if wanted.contains(&digest) {
                        let mut bytes = Vec::new();
                        std::io::Read::read_to_end(reader, &mut bytes)
                            .map_err(|e| super::archive::ArchiveError::Io(e.to_string()))?;
                        // The other side has stopped, on an error of its own: reading on would
                        // only decrypt the rest of the archive for nobody.
                        if sender.blocking_send((digest, bytes)).is_err() {
                            return Err(super::archive::ArchiveError::Io(
                                "the import stopped taking files".to_owned(),
                            ));
                        }
                    }
                }
                Ok(())
            })
        });

        while let Some((digest, bytes)) = received.recv().await {
            let Some(files) = pending.remove(&digest) else {
                continue;
            };
            for file in files {
                store_file(db, mapper, blobs, space_id, file, &digest, &bytes).await?;
                written.files_created += 1;
                written.files_seen += 1;
                note_every(db, mapper.job_id, Counter::Files, written.files_seen).await?;
            }
        }

        reading
            .await
            .map_err(|e| RunError::Db(e.to_string()))?
            .map_err(|e| RunError::Db(e.to_string()))?;

        // The checks refuse an archive whose file record points at bytes it does not carry, so
        // reaching this means the archive changed under us. Stopping is the only safe answer.
        if let Some(file) = pending.values().flatten().next() {
            return Err(RunError::Storage(format!(
                "{} has no bytes in the archive any more",
                file.name
            )));
        }
    }
    note_done(db, mapper.job_id, Counter::Files, written.files_seen).await?;

    Ok(written)
}

/// One file: its bytes, then the rows that describe them, then the correspondence.
async fn store_file<C: ConnectionTrait, S: BlobSink>(
    db: &C,
    mapper: &Mapper<'_>,
    blobs: &Blobs<'_, S>,
    space_id: Uuid,
    file: &super::archive::FileRecord,
    digest: &str,
    bytes: &[u8],
) -> Result<()> {
    let owner = match &file.uploaded_by {
        Some(source_id) => mapper.resolve(db, KIND_USER, source_id, None).await?,
        None => None,
    };
    let file_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let key = format!("spaces/{space_id}/{file_id}/{version_id}");

    // Bytes first. Everything below only describes what is already there.
    blobs
        .store
        .put(&key, bytes, &file.content_type)
        .await
        .map_err(RunError::Storage)?;

    // An image arrives with its dimensions and a thumbnail, exactly as an upload does. Without
    // them the product has no way to know it is lookable at: a photograph imported from a
    // conversation came out as a grey file card with a download button, next to the same
    // photograph uploaded here, which shows. A decode failure is not fatal - the bytes are stored
    // either way, and a file nobody can preview is still a file somebody can open.
    let (image_width, image_height, thumbnail_key) = if crate::files::mime::is_image(
        &file.content_type,
    ) {
        match crate::files::thumbnail::make_thumbnail(bytes, blobs.thumbnail_max_px) {
            Ok(info) => {
                let key = format!("{key}/thumb");
                blobs
                    .store
                    .put(
                        &key,
                        &info.thumbnail,
                        crate::files::thumbnail::THUMBNAIL_MIME,
                    )
                    .await
                    .map_err(RunError::Storage)?;
                (Some(info.width as i32), Some(info.height as i32), Some(key))
            }
            Err(error) => {
                tracing::warn!(%error, name = %file.name, "no thumbnail for this imported image");
                (None, None, None)
            }
        }
    } else {
        (None, None, None)
    };

    let created_at = file
        .uploaded_at
        .as_deref()
        .map(parse_instant)
        .unwrap_or_else(OffsetDateTime::now_utc);

    files::ActiveModel {
        id: Set(file_id),
        space_id: Set(space_id),
        owner_id: Set(owner),
        name: Set(file.name.clone()),
        // What kind of thing this is, from its media type, exactly as an upload decides it: the
        // product shows an image inline and a document as a card, and an imported photograph filed
        // as a plain "file" came out as a card next to the same photograph uploaded here.
        kind: Set(crate::files::mime::kind_for_mime(&file.content_type).to_owned()),
        parent_folder_id: Set(None),
        conversation_id: Set(None),
        system_key: Set(None),
        current_version_id: Set(None),
        size_bytes: Set(file.size),
        imported_source: Set(Some(mapper.source.to_owned())),
        external_ref: Set(Some(file.id.clone())),
        created_at: Set(created_at),
        updated_at: Set(created_at),
        deleted_at: Set(None),
    }
    .insert(db)
    .await?;

    file_versions::ActiveModel {
        id: Set(version_id),
        file_id: Set(file_id),
        version_no: Set(1),
        size_bytes: Set(file.size),
        content_hash: Set(hex_to_bytes(digest)),
        storage_key: Set(Some(key)),
        thumbnail_key: Set(thumbnail_key),
        mime_type: Set(file.content_type.clone()),
        image_width: Set(image_width),
        image_height: Set(image_height),
        created_by: Set(owner),
        created_at: Set(created_at),
    }
    .insert(db)
    .await?;

    let mut model: files::ActiveModel = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or_else(|| RunError::Db("the file vanished as it was written".to_owned()))?
        .into();
    model.current_version_id = Set(Some(version_id));
    model.update(db).await?;

    mapper
        .record(db, KIND_FILE, &file.id, Some(space_id), file_id)
        .await?;
    Ok(())
}

/// The digest as the database stores it: bytes, not the hex text the archive spells it in.
fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// Hangs the files a message carried onto that message.
///
/// Run after both passes: a message can name a file, and a file knows nothing about messages, so
/// neither pass can do it alone.
pub async fn attach_files<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    spaces_by_source: &[(String, Uuid)],
) -> Result<Written> {
    let mut written = Written::default();
    let Some((_, default_space)) = spaces_by_source.first() else {
        return Ok(written);
    };

    let mut records = Vec::new();
    super::archive::walk(archive, passphrase, |member| {
        if let super::archive::Member::Message(message) = member {
            if !message.files.is_empty() {
                records.push(message);
            }
        }
        Ok(())
    })
    .map_err(|e| RunError::Db(e.to_string()))?;

    for record in &records {
        for (position, reference) in record.files.iter().enumerate() {
            let mut message_id = None;
            for (_, space_id) in spaces_by_source {
                if message_id.is_none() {
                    message_id = mapper
                        .resolve(db, KIND_MESSAGE, &record.id, Some(*space_id))
                        .await?;
                }
            }
            let (Some(message_id), Some(file_id)) = (
                message_id,
                mapper
                    .resolve(db, KIND_FILE, reference, Some(*default_space))
                    .await?,
            ) else {
                continue;
            };

            if message_attachments::Entity::find_by_id((message_id, file_id))
                .one(db)
                .await?
                .is_some()
            {
                continue;
            }

            let version = file_versions::Entity::find()
                .filter(file_versions::Column::FileId.eq(file_id))
                .one(db)
                .await?
                .map(|version| version.id);

            message_attachments::ActiveModel {
                message_id: Set(message_id),
                file_id: Set(file_id),
                file_version_id: Set(version),
                position: Set(position as i32),
                alt_text: Set(None),
            }
            .insert(db)
            .await?;
            written.files_created += 1;
        }
    }

    Ok(written)
}

/// Closes imports that were running when the process stopped.
///
/// A run lives in a task inside this process. Restart the server and the task is gone, but the row
/// still says "running", so the screen watches a bar that will never move again and nothing says
/// why. Called once at boot, before anything can watch: whatever is still marked as running at
/// that moment is, by definition, something no task is behind any more.
///
/// Nothing written is undone. The correspondences are on disk, so running the same archive again
/// picks up where this left off, which is what the message says.
pub async fn close_abandoned_jobs<C: ConnectionTrait>(db: &C) -> Result<usize> {
    let stale = import_jobs::Entity::find()
        .filter(import_jobs::Column::Status.is_in(["running", "cancelling"]))
        .all(db)
        .await?;
    let found = stale.len();
    for job in stale {
        let mut model: import_jobs::ActiveModel = job.into();
        model.status = Set("failed".to_owned());
        model.error = Set(Some(
            "the server restarted while this import was running. Nothing it had already written \
             was lost: run the same archive again and it will pick up where it stopped."
                .to_owned(),
        ));
        model.finished_at = Set(Some(OffsetDateTime::now_utc()));
        model.update(db).await?;
    }
    Ok(found)
}

/// Whether an import is running right now.
///
/// Two at once would have them writing over each other's progress and racing on the same accounts.
/// Checked at the moment of starting, which leaves a window of milliseconds where two requests
/// could both pass; that is a far smaller problem than the one this closes, and an administrator
/// starting two imports in the same instant is not a case worth a lock.
pub async fn one_is_running<C: ConnectionTrait>(db: &C) -> Result<bool> {
    Ok(import_jobs::Entity::find()
        .filter(import_jobs::Column::Status.is_in(["running", "cancelling"]))
        .count(db)
        .await?
        > 0)
}

/// Turns the mentions in a body from what a producer can write into what the product resolves.
///
/// `docs/import-archive.md` requires a producer to write a mention as `@` followed by the person's
/// identifier at the source, rather than leaving `<@U123>` or whatever the vendor used: an
/// identifier is the one thing every source has and every producer can spell. The product resolves
/// a mention against a display name, so the crossing happens here, and a mention that arrived as
/// `@U123` sitting in the text as if somebody had typed it is what this prevents.
///
/// Matched longest-first: `@alice` and `@alice2` can both be people, and stopping at the first
/// identifier that fits would reach the wrong one. A run of text that matches nobody is left
/// exactly as it was - `@here`, `@canal` and an address are all ordinary text at this stage, and
/// the product decides what they mean when it reads the message.
fn rewrite_mentions(body: &str, handles: &std::collections::HashMap<String, String>) -> String {
    if body.is_empty() || handles.is_empty() {
        return body.to_owned();
    }
    // The scan walks characters rather than bytes: an identifier can be any text the source held,
    // and slicing a body on a byte boundary inside a name would panic.
    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let longest = handles
        .keys()
        .map(|id| id.chars().count())
        .max()
        .unwrap_or(0);

    let mut out = String::with_capacity(body.len());
    let mut index = 0;
    while index < chars.len() {
        let (offset, character) = chars[index];
        if character != '@' {
            out.push(character);
            index += 1;
            continue;
        }
        // Only at a word boundary, so that an address never turns into a mention.
        let boundary = index == 0 || !chars[index - 1].1.is_alphanumeric();
        let mut matched = None;
        // The braced form the contract spells out, `@{id}`, which is the one a producer reads in
        // `docs/import-archive.md` and the only one that is unambiguous when an identifier holds
        // punctuation. A producer wrote it, the importer only knew the bare form, and the mention
        // arrived on screen as `@{U0C40N926SC}` in front of the person it was meant to name.
        if boundary && chars.get(index + 1).map(|(_, c)| *c) == Some('{') {
            let open = chars[index + 1].0 + '{'.len_utf8();
            if let Some(close) = chars[index + 2..]
                .iter()
                .position(|(_, c)| *c == '}')
                .map(|at| index + 2 + at)
            {
                if let Some(handle) = handles.get(&body[open..chars[close].0]) {
                    out.push('@');
                    out.push_str(handle);
                    index = close + 1;
                    continue;
                }
            }
        }
        if boundary {
            let start = offset + character.len_utf8();
            for length in (1..=longest.min(chars.len() - index - 1)).rev() {
                let end = chars
                    .get(index + 1 + length)
                    .map(|(at, _)| *at)
                    .unwrap_or(body.len());
                if let Some(handle) = handles.get(&body[start..end]) {
                    matched = Some((handle, length));
                    break;
                }
            }
        }
        match matched {
            Some((handle, length)) => {
                out.push('@');
                out.push_str(handle);
                index += 1 + length;
            }
            None => {
                out.push(character);
                index += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod mention_tests {
    use super::rewrite_mentions;

    fn people() -> std::collections::HashMap<String, String> {
        [
            ("demo-camille", "Camille Vilain"),
            ("demo-yanis", "Yanis Berthier"),
            ("demo-yanis2", "Yanis Petit"),
            ("théo", "Théo Vilain"),
        ]
        .into_iter()
        .map(|(id, handle)| (id.to_owned(), handle.to_owned()))
        .collect()
    }

    /// Reported from a migrated Slack workspace: the mention read `@ThéoVilain` under a message
    /// that named Théo Vilain. A whole display name, spaces and all, is how the product addresses
    /// somebody, and squeezing it into one word names nobody.
    #[test]
    fn a_display_name_keeps_the_space_its_owner_writes() {
        assert_eq!(
            rewrite_mentions("@{théo} tu peux relire ?", &people()),
            "@Théo Vilain tu peux relire ?"
        );
    }

    /// The form `docs/import-archive.md` spells out. The Slack adapter wrote it, as the contract
    /// says to, and the mention reached the screen as `@{U0C40N926SC}`: the importer knew only the
    /// bare form its two earlier producers happened to use.
    #[test]
    fn the_braced_form_the_contract_documents_resolves_too() {
        assert_eq!(
            rewrite_mentions("@{demo-camille} c'est noté", &people()),
            "@Camille Vilain c'est noté"
        );
        assert_eq!(
            rewrite_mentions("@{demo-yanis} et @demo-camille", &people()),
            "@Yanis Berthier et @Camille Vilain"
        );
    }

    /// Braces around somebody this archive never carried stay exactly as they were: a producer
    /// naming a stranger is not a reason to invent one, and half-rewriting it would leave a
    /// mention pointing nowhere.
    #[test]
    fn a_braced_mention_of_nobody_is_left_alone() {
        assert_eq!(
            rewrite_mentions("@{U999} hello", &people()),
            "@{U999} hello"
        );
        assert_eq!(
            rewrite_mentions("@{demo-camille", &people()),
            "@{demo-camille"
        );
    }

    #[test]
    fn a_mention_arrives_as_a_name_the_product_can_resolve() {
        assert_eq!(
            rewrite_mentions("@demo-camille c'est noté", &people()),
            "@Camille Vilain c'est noté"
        );
    }

    #[test]
    fn the_longest_identifier_wins_over_one_that_merely_starts_it() {
        assert_eq!(
            rewrite_mentions("@demo-yanis2 et @demo-yanis", &people()),
            "@Yanis Petit et @Yanis Berthier"
        );
    }

    #[test]
    fn an_address_is_not_a_mention() {
        assert_eq!(
            rewrite_mentions("écris à contact@demo-camille", &people()),
            "écris à contact@demo-camille"
        );
    }

    #[test]
    fn a_handle_nobody_answers_to_is_left_alone() {
        assert_eq!(
            rewrite_mentions("@canal on se voit lundi", &people()),
            "@canal on se voit lundi"
        );
    }

    #[test]
    fn an_identifier_outside_ascii_does_not_split_a_character() {
        assert_eq!(
            rewrite_mentions("@théo ça va ?", &people()),
            "@Théo Vilain ça va ?"
        );
    }

    #[test]
    fn a_mention_at_the_very_end_of_a_body_is_still_one() {
        assert_eq!(
            rewrite_mentions("merci @demo-yanis", &people()),
            "merci @Yanis Berthier"
        );
    }
}
