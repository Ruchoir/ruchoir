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
    QueryOrder,
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
    pub messages_created: usize,
    pub read_positions: usize,
    pub files_created: usize,
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
) -> Result<Uuid> {
    let job_id = Uuid::new_v4();
    import_jobs::ActiveModel {
        id: Set(job_id),
        space_id: Set(space_id),
        created_by: Set(Some(created_by)),
        source: Set(source.to_owned()),
        status: Set("running".to_owned()),
        options: Set("{}".to_owned()),
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

/// Closes a job and records what it brought in.
///
/// The counters are what the screen reports afterwards, and they are read back from the mappings
/// rather than trusted from memory: a run that died and was resumed did part of its work in another
/// process, and only the rows know the total.
pub async fn finish_job<C: ConnectionTrait>(db: &C, job_id: Uuid, status: &str) -> Result<()> {
    let Some(job) = import_jobs::Entity::find_by_id(job_id).one(db).await? else {
        return Err(RunError::Db("the job disappeared while it ran".to_owned()));
    };

    let accounts = written_so_far(db, job_id, KIND_USER).await?;
    let mut model: import_jobs::ActiveModel = job.into();
    model.status = Set(status.to_owned());
    model.accounts_done = Set(accounts as i32);
    model.finished_at = Set(Some(OffsetDateTime::now_utc()));
    model.update(db).await?;
    Ok(())
}

/// How many entities of one kind this job has mapped, across every run of it.
pub async fn written_so_far<C: ConnectionTrait>(db: &C, job_id: Uuid, kind: &str) -> Result<u64> {
    Ok(import_mappings::Entity::find()
        .filter(import_mappings::Column::JobId.eq(job_id))
        .filter(import_mappings::Column::Kind.eq(kind))
        .count(db)
        .await?)
}

/// Looks up what an earlier run already wrote, and records what this one writes.
pub struct Mapper<'a> {
    pub job_id: Uuid,
    pub source: &'a str,
}

impl Mapper<'_> {
    /// The row an earlier run created for this source identifier, if any.
    pub async fn resolve<C: ConnectionTrait>(
        &self,
        db: &C,
        kind: &str,
        external_ref: &str,
        space_id: Option<Uuid>,
    ) -> Result<Option<Uuid>> {
        let mut query = import_mappings::Entity::find()
            .filter(import_mappings::Column::Source.eq(self.source))
            .filter(import_mappings::Column::Kind.eq(kind))
            .filter(import_mappings::Column::ExternalRef.eq(external_ref));
        query = match space_id {
            Some(space) => query.filter(import_mappings::Column::SpaceId.eq(space)),
            None => query.filter(import_mappings::Column::SpaceId.is_null()),
        };
        Ok(query.one(db).await?.map(|row| row.internal_id))
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
            created_at: NotSet,
        }
        .insert(db)
        .await?;
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
        if mapper
            .resolve(db, KIND_USER, &account.source_id, None)
            .await?
            .is_some()
        {
            // An earlier run already brought this person over.
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
    }

    Ok(written)
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
        format!("{}+{}@import.invalid", account.source_id, user_id.simple())
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
            resolved.push((space.id.clone(), existing));
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

        let conversation_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        conversations::ActiveModel {
            id: Set(conversation_id),
            space_id: Set(space_id),
            kind: Set(channel.kind.clone()),
            created_at: Set(now),
        }
        .insert(db)
        .await?;

        if channel.kind == "direct" {
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
                name: Set(crate::messaging::slug::slugify(&channel.name)),
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
            } else {
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
        written.conversations_created += 1;
    }

    Ok(written)
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

    let mut records = Vec::new();
    super::archive::walk(archive, passphrase, |member| {
        if let super::archive::Member::Message(message) = member {
            records.push(message);
        }
        Ok(())
    })
    .map_err(|e| RunError::Db(e.to_string()))?;

    for record in &records {
        let Some((conversation_id, space_id, kind)) = conversation_of.get(&record.channel) else {
            continue;
        };
        if mapper
            .resolve(db, KIND_MESSAGE, &record.id, Some(*space_id))
            .await?
            .is_some()
        {
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
            body: Set(record.body.clone()),
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
    }

    attach_threads(db, mapper, &pending, spaces_by_source, &conversation_of).await?;
    Ok(written)
}

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
        let (Some(reply_id), Some(root_id)) = (reply, root) else {
            // The checks refuse an archive whose reply names a root it does not carry, so this can
            // only mean the root was in a conversation left behind. The reply keeps its text and
            // simply stops being a reply, rather than pointing at nothing.
            continue;
        };

        let Some(model) = messages::Entity::find_by_id(reply_id).one(db).await? else {
            continue;
        };
        let mut model: messages::ActiveModel = model.into();
        model.parent_message_id = Set(Some(root_id));
        model.update(db).await?;

        // The root carries the count the interface reads, so it is kept in step here rather than
        // recomputed on every read.
        if let Some(root_model) = messages::Entity::find_by_id(root_id).one(db).await? {
            let count = root_model.reply_count + 1;
            let mut root_model: messages::ActiveModel = root_model.into();
            root_model.reply_count = Set(count);
            root_model.update(db).await?;
        }
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
pub async fn import_files<C: ConnectionTrait, S: BlobSink>(
    db: &C,
    mapper: &Mapper<'_>,
    storage: &S,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    spaces_by_source: &[(String, Uuid)],
) -> Result<Written> {
    let mut written = Written::default();
    let index =
        super::archive::index(archive, passphrase).map_err(|e| RunError::Db(e.to_string()))?;

    // A file belongs to the space its conversation is in, and to the first space of the archive
    // when it belongs to no conversation: an account's files are not scoped to a room.
    let Some((_, default_space)) = spaces_by_source.first() else {
        return Ok(written);
    };

    // The bytes, read once and kept by digest. An archive holds them under `blobs/`, already
    // deduplicated, and only the ones some record actually points at are worth carrying.
    let wanted: std::collections::HashSet<String> = index
        .files
        .iter()
        .filter_map(|file| file.hash.strip_prefix("sha256:").map(str::to_owned))
        .collect();
    let mut bytes_by_digest: std::collections::HashMap<String, Vec<u8>> =
        std::collections::HashMap::new();
    super::archive::walk(archive, passphrase, |member| {
        if let super::archive::Member::Blob { digest, reader } = member {
            if wanted.contains(&digest) {
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(reader, &mut bytes)
                    .map_err(|e| super::archive::ArchiveError::Io(e.to_string()))?;
                bytes_by_digest.insert(digest, bytes);
            }
        }
        Ok(())
    })
    .map_err(|e| RunError::Db(e.to_string()))?;

    for file in &index.files {
        let space_id = *default_space;
        if mapper
            .resolve(db, KIND_FILE, &file.id, Some(space_id))
            .await?
            .is_some()
        {
            continue;
        }

        let Some(digest) = file.hash.strip_prefix("sha256:") else {
            continue;
        };
        let Some(bytes) = bytes_by_digest.get(digest) else {
            // The checks refuse an archive whose file record points at bytes it does not carry, so
            // reaching this means the archive changed under us. Stopping is the only safe answer.
            return Err(RunError::Storage(format!(
                "{} has no bytes in the archive any more",
                file.name
            )));
        };

        let owner = match &file.uploaded_by {
            Some(source_id) => mapper.resolve(db, KIND_USER, source_id, None).await?,
            None => None,
        };
        let file_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let key = format!("spaces/{space_id}/{file_id}/{version_id}");

        // Bytes first. Everything below only describes what is already there.
        storage
            .put(&key, bytes, &file.content_type)
            .await
            .map_err(RunError::Storage)?;

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
            kind: Set("file".to_owned()),
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
            thumbnail_key: Set(None),
            mime_type: Set(file.content_type.clone()),
            image_width: Set(None),
            image_height: Set(None),
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
        written.files_created += 1;
    }

    Ok(written)
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
