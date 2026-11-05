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
//!   space, as it always has). No file of a conversation is ever published by link.
//!
//! On a file or a calendar, nothing is granted without seeing it: every other right there was
//! always checked after reading it. On a channel the rights stay independent of the view, because
//! moderation was always checked apart from it (a space administrator renames a channel reserved
//! away from administrators); handlers keep checking the view where they did.
//!
//! What a channel, file or calendar answers is its own family's permissions only.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::catalogue::{Family, Permission, PermissionSet};
use super::engine::{
    resolve, Decision, Effect, Facts, Level, LevelKind, Source, Standing, Step, Whom,
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
// Held to the decision by the tests; the screens ask through [`explain_for`].
#[allow(dead_code)]
pub async fn explain(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
) -> Result<Decision, DbErr> {
    decide(db, space_id, user_id, resource, true).await
}

/// An explained decision: the steps, and what the explanation needs to name beyond them.
#[derive(Clone, Debug)]
pub struct Explained {
    /// The decision with its trace, from the very path [`effective`] takes.
    pub decision: Decision,
    /// Each role the person holds through a group, with the groups of theirs that carry it.
    pub role_groups: HashMap<Uuid, Vec<Uuid>>,
    /// Where the person stands in the space.
    pub standing: Standing,
}

/// [`explain`] for the "Pourquoi ?" screen. `None` for somebody who is not in the space.
pub async fn explain_for(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
) -> Result<Option<Explained>, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let Some(person) = people.get(&user_id) else {
        return Ok(None);
    };
    let decision = decide_person(db, space_id, user_id, Some(person), resource, true).await?;
    Ok(Some(Explained {
        decision,
        role_groups: person.role_groups.clone(),
        standing: person.subject.standing,
    }))
}

/// The decision engine over one person and the levels of a resource. Every call goes through here
/// so that what applies to somebody beyond their own rules (a preview's ceiling) lives in one place.
///
/// While the person previews a role they hold what the preview gives them **and** what they
/// really hold: the decision is the intersection of the two, each over the rules that are about
/// it, so a preview never shows a channel, file or calendar its viewer cannot open. The trace is
/// the preview's.
pub(super) fn resolved(person: &Person, levels: &[Level], facts: Facts, explain: bool) -> Decision {
    let Some(ceiling) = &person.ceiling else {
        return resolve(&person.subject, levels, facts, explain);
    };
    let of = |keep: fn(Whom) -> bool| -> Vec<Level> {
        levels
            .iter()
            .map(|level| Level {
                rules: level
                    .rules
                    .iter()
                    .filter(|rule| keep(rule.whom))
                    .cloned()
                    .collect(),
                ..level.clone()
            })
            .collect()
    };
    // What is the viewer's own and not the role's stays on the ceiling's side alone: the channels
    // they joined (which open a private channel and add its view) and the files they wrote (which
    // add managing them). The preview shows what the role opens.
    let previewed = Facts {
        joined: false,
        author: false,
        ..facts
    };
    let mut decision = resolve(
        &person.subject,
        &of(|whom| whom != Whom::Viewer),
        previewed,
        explain,
    );
    let viewer = resolve(
        &ceiling.subject,
        &of(|whom| whom != Whom::Preview),
        facts,
        false,
    );
    decision.granted = decision.granted.intersect(viewer.granted);
    decision
}

/// `person` with the channels whose readers they are, among the audiences the `stored` rules name:
/// those channels, their rules and the person's memberships are read (three queries, none when no
/// rule names an audience) and each channel's own decision settles whether they read it. A channel
/// decision never reads file rules and an audience cannot sit on a channel (the schema forbids it),
/// so there is no cycle; somebody who cannot view the channel gets nothing from its rule.
pub(super) async fn with_audiences<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    person: &Person,
    stored: &[StoredRule],
) -> Result<Person, DbErr> {
    let mut named: Vec<Uuid> = stored
        .iter()
        .filter_map(|rule| rule.audience_channel_id)
        .collect();
    named.sort();
    named.dedup();
    let mut with = person.clone();
    if named.is_empty() {
        return Ok(with);
    }
    let channels = load::channels_of(db, space_id, &named).await?;
    let found: Vec<Uuid> = channels.iter().map(|channel| channel.id).collect();
    let rules = load::rules(
        db,
        space_id,
        permission_overrides::Column::ChannelId,
        &found,
    )
    .await?;
    let memberships = load::memberships(db, space_id, &found, Some(person.user_id)).await?;
    // `person` is passed with no readable audiences on purpose: an audience never applies to a
    // channel, so a channel's decision cannot depend on one and nothing recurses.
    with.readable_audiences = channels
        .iter()
        .filter(|channel| {
            channel_decision(person, channel, &rules, &memberships, false)
                .granted
                .contains(Permission::ChannelView)
        })
        .map(|channel| channel.id)
        .collect();
    Ok(with)
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

/// The members of the space who hold `permission` on the space itself, read through any
/// connection (a sweep reads them inside its transaction).
pub async fn space_holders<C: sea_orm::ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    permission: Permission,
) -> Result<Vec<Uuid>, DbErr> {
    let people = load::people(db, space_id, None).await?;
    Ok(people
        .values()
        .filter(|person| {
            resolved(person, &[], Facts::default(), false)
                .granted
                .contains(permission)
        })
        .map(|person| person.user_id)
        .collect())
}

/// The members of the space who hold `permission` on `resource`.
pub async fn holders(
    db: &DatabaseConnection,
    space_id: Uuid,
    resource: Resource,
    permission: Permission,
) -> Result<Vec<Uuid>, DbErr> {
    match resource {
        Resource::Channel(channel_id) => {
            return channel_holders(db, space_id, channel_id, permission).await;
        }
        Resource::Calendar(calendar_id) => {
            return calendar_holders(db, space_id, calendar_id, permission).await;
        }
        Resource::Space => return space_holders(db, space_id, permission).await,
        Resource::File(_) => {}
    }
    let people = load::people(db, space_id, None).await?;
    let mut holding = Vec::new();
    match resource {
        Resource::Space | Resource::Channel(_) | Resource::Calendar(_) => {}
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

/// Where `user_id` stands in the space: `None` when they are not in it (an expired guest
/// included). For the few rules that are about the standing itself rather than a permission: the
/// owner alone holds the space's identity and end, and a guest's channel role is no rank.
pub async fn standing(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<Standing>, DbErr> {
    Ok(load::people(db, space_id, Some(user_id))
        .await?
        .get(&user_id)
        .map(|person| person.subject.standing))
}

/// [`effective`] on many files of a space at once (a folder's entries, a search's results, what was
/// shared in conversations): the folders above them, every rule on them, the conversations they hang
/// off and the conversations they were posted in, each read in one go. Only a file that none of
/// those paths opens (a calendar event's file, a person no longer in the space) is decided on its
/// own. A file that is not in the space is left out of the map.
pub async fn files_effective(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    file_ids: &[Uuid],
) -> Result<HashMap<Uuid, PermissionSet>, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let mut out = HashMap::new();
    let Some(person) = people.get(&user_id) else {
        for id in file_ids {
            out.insert(*id, file_rights(db, space_id, user_id, *id).await?.granted);
        }
        return Ok(out);
    };
    let chains = load::file_chains(db, space_id, file_ids).await?;
    let mut every: Vec<Uuid> = chains.values().flatten().map(|row| row.id).collect();
    every.sort();
    every.dedup();
    let stored = load::rules(db, space_id, permission_overrides::Column::FileId, &every).await?;
    let audiences = with_audiences(db, space_id, person, &stored).await?;
    let person = &audiences;
    let levels_of = |chain: &[load::FileRow]| -> Vec<Level> {
        chain
            .iter()
            .map(|row| Level {
                kind: if row.kind == "folder" {
                    LevelKind::Folder
                } else {
                    LevelKind::File
                },
                id: row.id,
                rules: person.rules(
                    stored.iter().filter(|rule| rule.file_id == Some(row.id)),
                    None,
                ),
            })
            .collect()
    };
    let files_only = PermissionSet::of_family(Family::Files);

    // First the space tree: what the person reads from the space settles it. What they do not
    // (a guest) waits for the conversations it was posted in.
    let mut unseen_tree: Vec<(Uuid, PermissionSet)> = Vec::new();
    let mut carried: Vec<(Uuid, Uuid)> = Vec::new();
    for id in file_ids {
        let Some(file) = chains.get(id).and_then(|chain| chain.last()) else {
            continue;
        };
        if let Some(conversation_id) = file.conversation_id {
            carried.push((*id, conversation_id));
            continue;
        }
        let facts = Facts {
            author: file.owner_id == Some(user_id),
            ..Facts::default()
        };
        let granted = resolved(person, &levels_of(&chains[id]), facts, false)
            .granted
            .intersect(files_only);
        if granted.contains(Permission::FilesView) {
            out.insert(*id, granted);
        } else {
            unseen_tree.push((*id, granted));
        }
    }

    // The conversations involved, read once: those carrying files, those files were posted in.
    let unseen_ids: Vec<Uuid> = unseen_tree.iter().map(|(id, _)| *id).collect();
    let posted = load::posted_in(db, space_id, &unseen_ids).await?;
    let mut conversation_ids: Vec<Uuid> = carried
        .iter()
        .map(|(_, conversation)| *conversation)
        .chain(posted.iter().map(|(_, conversation)| *conversation))
        .collect();
    conversation_ids.sort();
    conversation_ids.dedup();
    let kinds = load::conversation_kinds(db, space_id, &conversation_ids).await?;
    let of_kind = |wanted: &str| -> Vec<Uuid> {
        kinds
            .iter()
            .filter(|(_, kind)| kind.as_str() == wanted)
            .map(|(id, _)| *id)
            .collect()
    };
    let channel_ids = of_kind("channel");
    let channels = load::channels_of(db, space_id, &channel_ids).await?;
    let channel_rules = load::rules(
        db,
        space_id,
        permission_overrides::Column::ChannelId,
        &channel_ids,
    )
    .await?;
    let memberships = load::memberships(db, space_id, &channel_ids, Some(user_id)).await?;
    let channel_by_id: HashMap<Uuid, &channels::Model> = channels
        .iter()
        .map(|channel| (channel.id, channel))
        .collect();
    let participating = load::dm_participation(db, space_id, user_id, &of_kind("direct")).await?;
    let reads = |conversation: Uuid| match kinds.get(&conversation).map(String::as_str) {
        Some("channel") => channel_by_id.get(&conversation).is_some_and(|channel| {
            channel_decision(person, channel, &channel_rules, &memberships, false)
                .granted
                .contains(Permission::ChannelView)
        }),
        Some("direct") => participating.contains(&conversation),
        _ => false,
    };

    let mut alone: Vec<Uuid> = Vec::new();
    // A conversation's file is its readers', and never published by link.
    for (id, conversation_id) in carried {
        let chain = &chains[&id];
        let file = chain.last().expect("a chain holds its file");
        let mut levels = Vec::new();
        let mut facts = Facts {
            author: file.owner_id == Some(user_id),
            ..Facts::default()
        };
        let view = match kinds.get(&conversation_id).map(String::as_str) {
            Some("channel") => {
                let Some(channel) = channel_by_id.get(&conversation_id) else {
                    // Its channel is gone, or another space's: nothing, as on its own.
                    out.insert(id, PermissionSet::EMPTY);
                    continue;
                };
                let (level, channel_facts) =
                    load::channel_level(person, channel, &channel_rules, &memberships);
                facts.private_channel = channel_facts.private_channel;
                facts.joined = channel_facts.joined;
                facts.archived = channel_facts.archived;
                levels.push(level);
                None
            }
            Some("direct") => Some(participating.contains(&conversation_id)),
            _ => {
                out.insert(id, PermissionSet::EMPTY);
                continue;
            }
        };
        levels.extend(levels_of(chain));
        let held = resolved(person, &levels, facts, false).granted;
        let view = view.unwrap_or_else(|| held.contains(Permission::ChannelView));
        if !view {
            alone.push(id);
            continue;
        }
        let mut granted = held.intersect(files_only);
        granted.insert(Permission::FilesView);
        granted.remove(Permission::FilesPublicLink);
        out.insert(id, granted);
    }
    // A space-tree file is read by whoever reads a message it is attached to.
    for (id, granted) in unseen_tree {
        let through_a_message = posted
            .iter()
            .any(|(file, conversation)| *file == id && reads(*conversation));
        if through_a_message {
            let mut granted = granted;
            granted.insert(Permission::FilesView);
            out.insert(id, granted);
        } else {
            alone.push(id);
        }
    }
    // What none of that opens: a calendar event may still, one file at a time.
    for id in alone {
        out.insert(id, file_rights(db, space_id, user_id, id).await?.granted);
    }
    Ok(out)
}

/// What someone may do with a file, and whether they read it only because a calendar event they
/// see carries it (read only, its content included).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileRights {
    pub granted: PermissionSet,
    pub through_event: bool,
}

/// [`effective`] on a file, with where its reading comes from.
pub async fn file_rights(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    file_id: Uuid,
) -> Result<FileRights, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let (decision, through_event) =
        file_decision(db, space_id, user_id, people.get(&user_id), file_id, false).await?;
    Ok(FileRights {
        granted: decision.granted,
        through_event,
    })
}

/// [`effective`] on the space itself, on any connection (a transaction included).
pub async fn space_rights<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<PermissionSet, DbErr> {
    Ok(load::people(db, space_id, Some(user_id))
        .await?
        .get(&user_id)
        .map(|person| resolved(person, &[], Facts::default(), false).granted)
        .unwrap_or_default())
}

/// [`effective`] on many calendars of a space at once, on any connection. A calendar that is not
/// one of the space's is left out of the map.
pub async fn calendar_rights_many<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
    calendar_ids: &[Uuid],
) -> Result<HashMap<Uuid, PermissionSet>, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    let Some(person) = people.get(&user_id) else {
        return Ok(HashMap::new());
    };
    let calendars = load::calendars_of(db, space_id, calendar_ids).await?;
    let found: Vec<Uuid> = calendars.iter().map(|calendar| calendar.id).collect();
    let rules = load::rules(
        db,
        space_id,
        permission_overrides::Column::CalendarId,
        &found,
    )
    .await?;
    Ok(found
        .into_iter()
        .map(|id| (id, calendar_decision(person, id, &rules, false).granted))
        .collect())
}

/// The members of the space who hold `permission` on one of its calendars, on any connection.
pub async fn calendar_holders<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    calendar_id: Uuid,
    permission: Permission,
) -> Result<Vec<Uuid>, DbErr> {
    if load::calendars_of(db, space_id, &[calendar_id])
        .await?
        .is_empty()
    {
        return Ok(Vec::new());
    }
    let people = load::people(db, space_id, None).await?;
    let rules = load::rules(
        db,
        space_id,
        permission_overrides::Column::CalendarId,
        &[calendar_id],
    )
    .await?;
    Ok(people
        .values()
        .filter(|person| {
            calendar_decision(person, calendar_id, &rules, false)
                .granted
                .contains(permission)
        })
        .map(|person| person.user_id)
        .collect())
}

/// The space's owners (the standing, not a permission: outside every rule).
pub async fn owners(db: &DatabaseConnection, space_id: Uuid) -> Result<Vec<Uuid>, DbErr> {
    Ok(load::people(db, space_id, None)
        .await?
        .into_values()
        .filter(|person| person.subject.standing == Standing::Owner)
        .map(|person| person.user_id)
        .collect())
}

/// What a question about a channel takes for granted, when it is not "may they read it now".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Assume {
    /// Taken as joined (`Some(true)`), as not joined (`Some(false)`), or as it is (`None`).
    pub joined: Option<bool>,
    /// Taken as public whatever its type: who would see it were it not private (who must hear
    /// that it was made private, for one).
    pub public: bool,
}

/// Whether `user_id` would see the channel under `assume`: "would it admit them if they joined"
/// (adding someone), "may they walk in" (joining).
pub async fn sees_channel(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    channel_id: Uuid,
    assume: Assume,
) -> Result<bool, DbErr> {
    Ok(
        channel_viewers_among(db, space_id, channel_id, Some(user_id), assume)
            .await?
            .contains(&user_id),
    )
}

/// The members of the space who would see the channel under `assume`, in a fixed number of
/// queries.
pub async fn channel_viewers<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_id: Uuid,
    assume: Assume,
) -> Result<Vec<Uuid>, DbErr> {
    channel_viewers_among(db, space_id, channel_id, None, assume).await
}

/// The members of the space who hold `permission` on one of its channels, as it is, on any
/// connection (a transaction included): who a channel's content may be sent to, for one.
pub async fn channel_holders<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_id: Uuid,
    permission: Permission,
) -> Result<Vec<Uuid>, DbErr> {
    let people = load::people(db, space_id, None).await?;
    let channels = load::channels_of(db, space_id, &[channel_id]).await?;
    let Some(channel) = channels.first() else {
        return Ok(Vec::new());
    };
    let ids = [channel_id];
    let rules = load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
    let memberships = load::memberships(db, space_id, &ids, None).await?;
    Ok(people
        .values()
        .filter(|person| {
            channel_decision(person, channel, &rules, &memberships, false)
                .granted
                .contains(permission)
        })
        .map(|person| person.user_id)
        .collect())
}

/// [`channel_holders`] among some members only (a channel's rows): what an audience asks, without
/// reading the rest of the space.
pub async fn channel_holders_among<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_id: Uuid,
    permission: Permission,
    among: &[Uuid],
) -> Result<Vec<Uuid>, DbErr> {
    let people = load::people_among(db, space_id, among).await?;
    if people.is_empty() {
        return Ok(Vec::new());
    }
    let channels = load::channels_of(db, space_id, &[channel_id]).await?;
    let Some(channel) = channels.first() else {
        return Ok(Vec::new());
    };
    let ids = [channel_id];
    let rules = load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
    let memberships = load::memberships(db, space_id, &ids, None).await?;
    Ok(people
        .values()
        .filter(|person| {
            channel_decision(person, channel, &rules, &memberships, false)
                .granted
                .contains(permission)
        })
        .map(|person| person.user_id)
        .collect())
}

async fn channel_viewers_among<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_id: Uuid,
    user: Option<Uuid>,
    assume: Assume,
) -> Result<Vec<Uuid>, DbErr> {
    let people = load::people(db, space_id, user).await?;
    let channels = load::channels_of(db, space_id, &[channel_id]).await?;
    let Some(mut channel) = channels.into_iter().next() else {
        return Ok(Vec::new());
    };
    if assume.public && channel.channel_type == "private" {
        channel.channel_type = "public".to_owned();
    }
    let ids = [channel_id];
    let rules = load::rules(db, space_id, permission_overrides::Column::ChannelId, &ids).await?;
    let mut memberships = load::memberships(db, space_id, &ids, user).await?;
    match assume.joined {
        Some(true) => {
            for person in people.keys() {
                memberships
                    .entry((channel_id, *person))
                    .or_insert_with(|| "member".to_owned());
            }
        }
        Some(false) => memberships.clear(),
        None => {}
    }
    Ok(people
        .values()
        .filter(|person| {
            channel_decision(person, &channel, &rules, &memberships, false)
                .granted
                .contains(Permission::ChannelView)
        })
        .map(|person| person.user_id)
        .collect())
}

async fn decide(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
    explain: bool,
) -> Result<Decision, DbErr> {
    let people = load::people(db, space_id, Some(user_id)).await?;
    decide_person(
        db,
        space_id,
        user_id,
        people.get(&user_id),
        resource,
        explain,
    )
    .await
}

async fn decide_person(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    person: Option<&Person>,
    resource: Resource,
    explain: bool,
) -> Result<Decision, DbErr> {
    match resource {
        Resource::Space => Ok(person
            .map(|person| resolved(person, &[], Facts::default(), explain))
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
        Resource::File(file_id) => Ok(file_decision(
            db, space_id, user_id, person, file_id, explain,
        )
        .await?
        .0),
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
    let mut decision = resolved(person, std::slice::from_ref(&level), facts, explain);
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
    let mut decision = resolved(person, &[level], Facts::default(), explain);
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

async fn file_decision(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    person: Option<&Person>,
    file_id: Uuid,
    explain: bool,
) -> Result<(Decision, bool), DbErr> {
    let chain = load::file_chain(db, space_id, file_id).await?;
    let Some(file) = chain.last().cloned() else {
        return Ok((Decision::default(), false));
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
                        None => return Ok((Decision::default(), false)),
                    }
                }
                Some("direct") => Conversation::Direct(
                    dm_participants::Entity::find_by_id((conversation_id, user_id))
                        .one(db)
                        .await?
                        .is_some(),
                ),
                _ => return Ok((Decision::default(), false)),
            }
        }
    };

    // Somebody who is not (or no longer) in the space holds nothing on a file, even one from a
    // direct message they once took part in: a participant row outlives the membership (so that
    // coming back gives the history back) but grants nothing alone.

    let mut decision = Decision::default();
    if let Some(person) = person {
        let ids: Vec<Uuid> = chain.iter().map(|row| row.id).collect();
        let stored = load::rules(db, space_id, permission_overrides::Column::FileId, &ids).await?;
        let person = &with_audiences(db, space_id, person, &stored).await?;
        let mut levels = Vec::new();
        let mut facts = Facts {
            author: file.owner_id == Some(user_id),
            ..Facts::default()
        };
        if let Conversation::Channel(channel) = &conversation {
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
            levels.push(Level {
                kind: if row.kind == "folder" {
                    LevelKind::Folder
                } else {
                    LevelKind::File
                },
                id: row.id,
                rules: person.rules(
                    stored.iter().filter(|rule| rule.file_id == Some(row.id)),
                    None,
                ),
            });
        }
        decision = resolved(person, &levels, facts, explain);
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
            // A conversation's file belongs to its participants, never to whoever holds a link.
            set(
                &mut decision,
                Permission::FilesPublicLink,
                false,
                Source::Implicit("conversation"),
                explain,
            );
        }
    }

    if let (false, None, Some(person)) = (
        decision.granted.contains(Permission::FilesView),
        file.conversation_id,
        person,
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
    let through_event = !decision.granted.contains(Permission::FilesView)
        && event_grants(db, file_id, user_id).await;
    if through_event {
        set(
            &mut decision,
            Permission::FilesView,
            true,
            Source::Implicit("event"),
            explain,
        );
    }
    Ok((decision, through_event))
}

/// Whether a calendar event the person sees carries the file. Boxed: seeing an event can go
/// through reading a channel, which asks this module again.
fn event_grants<'a>(
    db: &'a DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
    Box::pin(crate::calendar::attachments::grants(db, file_id, user_id))
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
