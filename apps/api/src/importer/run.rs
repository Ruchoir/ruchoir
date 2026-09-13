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
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::entities::{
    channel_members, channels, conversations, dm_conversations, dm_participants, import_jobs,
    import_mappings, space_members, spaces, users,
};

use super::archive::Index;
use super::plan::{AccountOutcome, Plan};

pub const KIND_SPACE: &str = "space";
pub const KIND_USER: &str = "user";
pub const KIND_CHANNEL: &str = "channel";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Written {
    pub accounts_created: usize,
    pub accounts_matched: usize,
    pub spaces_created: usize,
    pub spaces_filled: usize,
    pub memberships: usize,
    pub conversations_created: usize,
}

#[derive(Debug)]
pub enum RunError {
    Db(String),
    /// The instance cannot tell which row the archive means. Refusing is the only safe answer: the
    /// alternative is pouring someone's history into the wrong place.
    Ambiguous(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Db(message) | RunError::Ambiguous(message) => write!(f, "{message}"),
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
