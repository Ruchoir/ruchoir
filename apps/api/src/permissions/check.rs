//! The questions handlers ask: may this person do this, here, and who may.
//!
//! Every answer is the engine's ([`super::engine::resolve`]) over what the loader read, plus the
//! paths to a file that are not rules and stay as they were:
//!
//! - **A file attached to a message** is read by whoever reads the message (a guest reaches a
//!   space-tree file that way, and only that way).
//! - **A calendar event grants reading the files it carries** to whoever sees the event, read only,
//!   even from outside the file's own audience (`crate::calendar::attachments`).
//! - **A file in a direct message** is the participants' (and stays so after one of them left the
//!   space, as it always has).
//!
//! On a file or a calendar, nothing is granted without seeing it: every other right there was
//! always checked after reading it. On a channel the rights stay independent of the view, because
//! moderation was always checked apart from it (a space administrator renames a channel reserved
//! away from administrators); handlers keep checking the view where they did.
//!
//! What a channel, file or calendar answers is its own family's permissions only.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::catalogue::{Family, Permission, PermissionSet};
use super::engine::{
    resolve, Decision, Effect, Facts, Level, LevelKind, Source, Standing, Step, Subject,
};
use super::load::{self, Person, StoredRule};
use crate::entities::{
    channels, conversations, dm_participants, message_attachments, messages, permission_overrides,
};

pub use super::load::Resource;

/// Whether `user_id` holds `permission` on `resource` in `space_id`.
pub async fn can(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
    permission: Permission,
) -> Result<bool, DbErr> {
    Ok(effective(db, space_id, user_id, resource)
        .await?
        .contains(permission))
}

/// Everything `user_id` holds on `resource`: empty for someone not in the space (an expired guest
/// included) and for a resource of another space.
pub async fn effective(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
) -> Result<PermissionSet, DbErr> {
    Ok(decide(db, space_id, user_id, resource, false)
        .await?
        .granted)
}

/// [`effective`] with every step that led to it: "why may they?".
pub async fn explain(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
) -> Result<Decision, DbErr> {
    decide(db, space_id, user_id, resource, true).await
}

/// [`effective`] on many channels of a space at once, in a fixed number of queries. A channel that
/// is not in the space is left out of the map.
pub async fn effective_many(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    channel_ids: &[Uuid],
) -> Result<HashMap<Uuid, PermissionSet>, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let Some(person) = people.get(&user_id) else {
        return Ok(HashMap::new());
    };
    let channels = load::channels_of(db, space_id, channel_ids).await?;
    let found: Vec<Uuid> = channels.iter().map(|channel| channel.id).collect();
    let rules = load::rules(
        db,
        space_id,
        permission_overrides::Column::ChannelId,
        &found,
    )
    .await?;
    let memberships = load::memberships(db, space_id, &found, Some(user_id)).await?;
    Ok(channels
        .iter()
        .map(|channel| {
            let decision = channel_decision(person, channel, &rules, &memberships, false);
            (channel.id, decision.granted)
        })
        .collect())
}

/// The members of the space who hold `permission` on `resource`.
pub async fn holders(
    db: &DatabaseConnection,
    space_id: Uuid,
    resource: Resource,
    permission: Permission,
) -> Result<Vec<Uuid>, DbErr> {
    let people = load::people(db, space_id, None).await?;
    let mut holding = Vec::new();
    match resource {
        Resource::Space => {
            for person in people.values() {
                if resolve(&person.subject, &[], Facts::default(), false)
                    .granted
                    .contains(permission)
                {
                    holding.push(person.user_id);
                }
            }
        }
        Resource::Channel(channel_id) => {
            let channels = load::channels_of(db, space_id, &[channel_id]).await?;
            let Some(channel) = channels.first() else {
                return Ok(holding);
            };
            let ids = [channel_id];
            let rules =
                load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
            let memberships = load::memberships(db, space_id, &ids, None).await?;
            for person in people.values() {
                if channel_decision(person, channel, &rules, &memberships, false)
                    .granted
                    .contains(permission)
                {
                    holding.push(person.user_id);
                }
            }
        }
        Resource::Calendar(calendar_id) => {
            if load::calendar_of(db, space_id, calendar_id)
                .await?
                .is_none()
            {
                return Ok(holding);
            }
            let rules = load::rules(
                db,
                space_id,
                permission_overrides::Column::CalendarId,
                &[calendar_id],
            )
            .await?;
            for person in people.values() {
                if calendar_decision(person, calendar_id, &rules, false)
                    .granted
                    .contains(permission)
                {
                    holding.push(person.user_id);
                }
            }
        }
        Resource::File(_) => {
            // One person at a time: a file's paths through messages and events are per person.
            for person in people.values() {
                if decide(db, space_id, person.user_id, resource, false)
                    .await?
                    .granted
                    .contains(permission)
                {
                    holding.push(person.user_id);
                }
            }
        }
    }
    Ok(holding)
}

async fn decide(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
    explain: bool,
) -> Result<Decision, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let person = people.get(&user_id);
    match resource {
        Resource::Space => Ok(person
            .map(|person| resolve(&person.subject, &[], Facts::default(), explain))
            .unwrap_or_default()),
        Resource::Channel(channel_id) => {
            let Some(person) = person else {
                return Ok(Decision::default());
            };
            channel_decision_by_id(db, space_id, person, channel_id, explain).await
        }
        Resource::Calendar(calendar_id) => {
            let Some(person) = person else {
                return Ok(Decision::default());
            };
            if load::calendar_of(db, space_id, calendar_id)
                .await?
                .is_none()
            {
                return Ok(Decision::default());
            }
            let rules = load::rules(
                db,
                space_id,
                permission_overrides::Column::CalendarId,
                &[calendar_id],
            )
            .await?;
            Ok(calendar_decision(person, calendar_id, &rules, explain))
        }
        Resource::File(file_id) => {
            file_decision(db, space_id, user_id, person, file_id, explain).await
        }
    }
}

async fn channel_decision_by_id(
    db: &DatabaseConnection,
    space_id: Uuid,
    person: &Person,
    channel_id: Uuid,
    explain: bool,
) -> Result<Decision, DbErr> {
    let channels = load::channels_of(db, space_id, &[channel_id]).await?;
    let Some(channel) = channels.first() else {
        return Ok(Decision::default());
    };
    let ids = [channel_id];
    let rules = load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
    let memberships = load::memberships(db, space_id, &ids, Some(person.user_id)).await?;
    Ok(channel_decision(
        person,
        channel,
        &rules,
        &memberships,
        explain,
    ))
}

fn channel_decision(
    person: &Person,
    channel: &channels::Model,
    rules: &[StoredRule],
    memberships: &HashMap<(Uuid, Uuid), String>,
    explain: bool,
) -> Decision {
    let (level, facts) = load::channel_level(person, channel, rules, memberships);
    let mut decision = resolve(
        &person.subject,
        std::slice::from_ref(&level),
        facts,
        explain,
    );
    decision.granted = decision
        .granted
        .intersect(PermissionSet::of_family(Family::Channel));
    decision
}

fn calendar_decision(
    person: &Person,
    calendar_id: Uuid,
    rules: &[StoredRule],
    explain: bool,
) -> Decision {
    let level = Level {
        kind: LevelKind::Calendar,
        id: calendar_id,
        rules: person.rules(
            rules
                .iter()
                .filter(|rule| rule.calendar_id == Some(calendar_id)),
            None,
        ),
    };
    let mut decision = resolve(&person.subject, &[level], Facts::default(), explain);
    decision.granted = decision
        .granted
        .intersect(PermissionSet::of_family(Family::Calendar));
    unseen_grants_nothing(
        &mut decision,
        Permission::CalendarView,
        Family::Calendar,
        explain,
    );
    decision
}

/// Where the file's audience comes from when it hangs off a conversation.
enum Conversation {
    /// A space-tree file.
    None,
    /// Attached in a channel: that channel's readers.
    Channel(Box<channels::Model>),
    /// Attached in a direct message: whether the caller takes part in it.
    Direct(bool),
}

/// What a person not (or no longer) in the space holds on a direct message's file they take part
/// in: what they held before leaving, as the participant rule always gave it.
const OUTSIDE_PARTICIPANT: PermissionSet =
    PermissionSet::of(&[Permission::FilesView, Permission::FilesEdit]);

async fn file_decision(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    person: Option<&Person>,
    file_id: Uuid,
    explain: bool,
) -> Result<Decision, DbErr> {
    let chain = load::file_chain(db, space_id, file_id).await?;
    let Some(file) = chain.last().cloned() else {
        return Ok(Decision::default());
    };
    let conversation = match file.conversation_id {
        None => Conversation::None,
        Some(conversation_id) => {
            match conversation_kind(db, space_id, conversation_id)
                .await?
                .as_deref()
            {
                Some("channel") => {
                    match load::channels_of(db, space_id, &[conversation_id])
                        .await?
                        .pop()
                    {
                        Some(channel) => Conversation::Channel(Box::new(channel)),
                        None => return Ok(Decision::default()),
                    }
                }
                Some("direct") => Conversation::Direct(
                    dm_participants::Entity::find_by_id((conversation_id, user_id))
                        .one(db)
                        .await?
                        .is_some(),
                ),
                _ => return Ok(Decision::default()),
            }
        }
    };

    let outsider;
    let (subject, owner): (Option<&Subject>, Option<&Person>) = match (person, &conversation) {
        (Some(person), _) => (Some(&person.subject), Some(person)),
        (None, Conversation::Direct(true)) => {
            outsider = Subject {
                standing: Standing::Member,
                base: OUTSIDE_PARTICIPANT,
                roles: Vec::new(),
            };
            (Some(&outsider), None)
        }
        (None, _) => (None, None),
    };

    let mut decision = Decision::default();
    if let Some(subject) = subject {
        let ids: Vec<Uuid> = chain.iter().map(|row| row.id).collect();
        let stored = load::rules(db, space_id, permission_overrides::Column::FileId, &ids).await?;
        let mut levels = Vec::new();
        let mut facts = Facts {
            author: file.owner_id == Some(user_id),
            ..Facts::default()
        };
        if let (Conversation::Channel(channel), Some(person)) = (&conversation, owner) {
            let ids = [channel.id];
            let rules =
                load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
            let memberships = load::memberships(db, space_id, &ids, Some(user_id)).await?;
            let (level, channel_facts) = load::channel_level(person, channel, &rules, &memberships);
            facts.private_channel = channel_facts.private_channel;
            facts.joined = channel_facts.joined;
            facts.archived = channel_facts.archived;
            levels.push(level);
        }
        for row in &chain {
            let rules = match owner {
                Some(person) => person.rules(
                    stored.iter().filter(|rule| rule.file_id == Some(row.id)),
                    None,
                ),
                None => Vec::new(),
            };
            levels.push(Level {
                kind: if row.kind == "folder" {
                    LevelKind::Folder
                } else {
                    LevelKind::File
                },
                id: row.id,
                rules,
            });
        }
        decision = resolve(subject, &levels, facts, explain);
        // A conversation's file is its readers', whatever the space-wide right says.
        let view = match conversation {
            Conversation::None => None,
            Conversation::Channel(_) => Some(decision.granted.contains(Permission::ChannelView)),
            Conversation::Direct(participant) => Some(participant),
        };
        decision.granted = decision
            .granted
            .intersect(PermissionSet::of_family(Family::Files));
        if let Some(view) = view {
            set(
                &mut decision,
                Permission::FilesView,
                view,
                Source::Implicit("conversation"),
                explain,
            );
        }
    }

    if let (false, None, Some(person)) = (
        decision.granted.contains(Permission::FilesView),
        file.conversation_id,
        owner,
    ) {
        if reaches_through_a_message(db, space_id, person, file_id).await? {
            set(
                &mut decision,
                Permission::FilesView,
                true,
                Source::Implicit("message"),
                explain,
            );
        }
    }
    unseen_grants_nothing(&mut decision, Permission::FilesView, Family::Files, explain);
    if !decision.granted.contains(Permission::FilesView)
        && crate::calendar::attachments::grants(db, file_id, user_id).await
    {
        set(
            &mut decision,
            Permission::FilesView,
            true,
            Source::Implicit("event"),
            explain,
        );
    }
    Ok(decision)
}

async fn conversation_kind(
    db: &DatabaseConnection,
    space_id: Uuid,
    conversation_id: Uuid,
) -> Result<Option<String>, DbErr> {
    Ok(conversations::Entity::find_by_id(conversation_id)
        .filter(conversations::Column::SpaceId.eq(space_id))
        .one(db)
        .await?
        .map(|conversation| conversation.kind))
}

/// Whether the file hangs off a message in a conversation of the space the person may read.
async fn reaches_through_a_message(
    db: &DatabaseConnection,
    space_id: Uuid,
    person: &Person,
    file_id: Uuid,
) -> Result<bool, DbErr> {
    let message_ids: Vec<Uuid> = message_attachments::Entity::find()
        .filter(message_attachments::Column::FileId.eq(file_id))
        .all(db)
        .await?
        .into_iter()
        .map(|attachment| attachment.message_id)
        .collect();
    if message_ids.is_empty() {
        return Ok(false);
    }
    let conversation_ids: std::collections::BTreeSet<Uuid> = messages::Entity::find()
        .filter(messages::Column::Id.is_in(message_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|message| message.conversation_id)
        .collect();
    for conversation_id in conversation_ids {
        let readable = match conversation_kind(db, space_id, conversation_id)
            .await?
            .as_deref()
        {
            Some("channel") => channel_decision_by_id(db, space_id, person, conversation_id, false)
                .await?
                .granted
                .contains(Permission::ChannelView),
            Some("direct") => {
                dm_participants::Entity::find_by_id((conversation_id, person.user_id))
                    .one(db)
                    .await?
                    .is_some()
            }
            _ => false,
        };
        if readable {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Give or take one permission outside the rules, keeping the trace honest.
fn set(decision: &mut Decision, permission: Permission, on: bool, source: Source, explain: bool) {
    if decision.granted.contains(permission) == on {
        return;
    }
    let effect = if on {
        decision.granted.insert(permission);
        Effect::Granted
    } else {
        decision.granted.remove(permission);
        Effect::Removed
    };
    if explain {
        decision.trace.push(Step {
            permission,
            effect,
            source,
            level: None,
        });
    }
}

/// Nothing on a file or a calendar without seeing it.
fn unseen_grants_nothing(decision: &mut Decision, view: Permission, family: Family, explain: bool) {
    if decision.granted.contains(view) {
        return;
    }
    for permission in PermissionSet::of_family(family).iter() {
        set(
            decision,
            permission,
            false,
            Source::Implicit("unseen"),
            explain,
        );
    }
}
