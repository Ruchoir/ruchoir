//! What an import would do, decided before it does anything.
//!
//! The plan is the screen an administrator approves. It answers three questions and nothing else:
//! which spaces are created and which are filled, which accounts are recognised and which are not,
//! and what the producer already said it left behind.
//!
//! It is a pure function of the archive and of what the instance already holds. Nothing here reads
//! or writes the database: the caller passes in what exists, which keeps the decisions testable
//! without a database and, more importantly, keeps them auditable. An import that writes before it
//! has shown this is an import nobody agreed to.
//!
//! **Accounts are matched on their address, and only on their address.** Matching on a display
//! name would eventually attribute one person's messages to another, which is not a bug that gets
//! noticed and not one that can be undone. An account with no address matches nothing, and that is
//! the ordinary case rather than the exception: a Nextcloud with no mail server has no addresses at
//! all, six out of six in the fixture we develop against.

use std::collections::{HashMap, HashSet};

use super::archive::Index;

/// What happens to a space the archive carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpaceOutcome {
    /// No space of that name here: the import creates it, owned by whoever ran the import.
    Created,
    /// A space of that name already exists, and the import adds to it.
    Filled,
}

#[derive(Debug, Clone)]
pub struct SpacePlan {
    pub source_id: String,
    pub name: String,
    pub description: String,
    pub outcome: SpaceOutcome,
    pub channels: usize,
    pub directs: usize,
    /// How many of those channels a space of this name here already has, under the same handle.
    ///
    /// They are not created a second time - a name is unique within a space - so the archive's
    /// history goes into the channel that is already there. Said here because it is a merge, and
    /// a plan that counted them as new would be promising an import that cannot happen.
    pub channels_filled: usize,
}

/// What happens to an account the archive carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountOutcome {
    /// An account here already has this address: the two are the same person.
    Matched,
    /// Nobody here has this address, but there is one: an account can be created and invited.
    Invited,
    /// No address at all. Nothing can be matched and no invitation can be sent: this one needs a
    /// decision from the administrator, and it is the common case on an instance without mail.
    NeedsDecision,
}

#[derive(Debug, Clone)]
pub struct AccountPlan {
    pub source_id: String,
    pub display_name: String,
    pub email: String,
    pub active: bool,
    pub outcome: AccountOutcome,
    /// The administrator asked for this person to be left out.
    ///
    /// Left out of the accounts, not out of the archive: their messages still arrive with no
    /// author, the way a message from somebody the archive never named arrives. Dropping the text
    /// as well would be a loss nobody asked for; this is a decision about people.
    pub skipped: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub source: String,
    pub spaces: Vec<SpacePlan>,
    pub accounts: Vec<AccountPlan>,
    pub messages: usize,
    pub files: usize,
    pub bytes: i64,
    /// The producer's own words about what it could not take. Carried through unchanged and shown
    /// before the run: a summary of a loss is another way of hiding it.
    pub limits: Vec<String>,
}

impl Plan {
    pub fn accounts_with(&self, outcome: AccountOutcome) -> usize {
        self.accounts
            .iter()
            .filter(|a| a.outcome == outcome)
            .count()
    }

    pub fn spaces_created(&self) -> usize {
        self.spaces
            .iter()
            .filter(|s| s.outcome == SpaceOutcome::Created)
            .count()
    }

    /// Whether anyone can be invited by mail at all. An import that recognises nobody and can
    /// invite nobody still works, but every person needs a link handed to them by other means, and
    /// the administrator should learn that before starting rather than afterwards.
    pub fn anyone_reachable_by_mail(&self) -> bool {
        self.accounts
            .iter()
            .any(|a| a.outcome == AccountOutcome::Invited)
    }
}

/// What an administrator changed about the people in an archive, after reading the plan and before
/// the run.
///
/// Held apart from the plan because it is not the archive's word: the archive says what its source
/// held, and this says what somebody decided about it. Carried on the job so a run resumed tomorrow
/// makes the same decisions as the one that started today.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct PersonChoice {
    pub source_id: String,
    /// An address given or corrected by hand. The common case is a person the export carried
    /// without one, who cannot otherwise be invited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Leave this person out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skip: bool,
}

/// Applies what the administrator decided.
///
/// An address given by hand can change what happens to a person: someone the archive carried
/// without one could be neither matched nor invited, and with one they are either recognised as an
/// account already here or invitable. So the outcome is worked out again rather than kept.
pub fn apply_choices(plan: &mut Plan, choices: &[PersonChoice], existing: &Existing) {
    for choice in choices {
        let Some(account) = plan
            .accounts
            .iter_mut()
            .find(|a| a.source_id == choice.source_id)
        else {
            // A choice about somebody this archive does not carry. Ignored rather than refused:
            // the plan and the choices can be minutes apart, and this changes nothing.
            continue;
        };
        account.skipped = choice.skip;
        if let Some(email) = &choice.email {
            (account.email, account.outcome) = account_outcome(email, existing);
        }
    }
}

/// What an address decides about a person, and the address they keep.
///
/// Compared case-insensitively: the same person writes theirs in whichever case they feel like, and
/// two accounts differing only in case are one person, not two.
///
/// In a [scoped](Existing::scoped) import, an address that is not the importer's own is withheld:
/// the person arrives with none, as if the export had carried none. See [`Existing::scoped`].
fn account_outcome(email: &str, existing: &Existing) -> (String, AccountOutcome) {
    let email = email.trim();
    let folded = email.to_lowercase();
    let known = existing
        .emails
        .iter()
        .any(|known| known.to_lowercase() == folded);
    if email.is_empty() {
        (String::new(), AccountOutcome::NeedsDecision)
    } else if known {
        (email.to_owned(), AccountOutcome::Matched)
    } else if existing.scoped {
        (String::new(), AccountOutcome::NeedsDecision)
    } else {
        (email.to_owned(), AccountOutcome::Invited)
    }
}

/// What the instance already holds, as far as the plan is concerned.
#[derive(Debug, Default)]
pub struct Existing {
    /// Addresses of the accounts here, lowercased by the caller's query.
    pub emails: Vec<String>,
    /// Names of the spaces here.
    pub space_names: Vec<String>,
    /// The channels here, as (space name, channel handle). Both sides are what the run matches on.
    pub channels: Vec<(String, String)>,
    /// The person importing does not administer the instance.
    ///
    /// Anyone may bring a workspace over, but only into spaces of their own and without reaching
    /// anybody else's account. So a scoped import is shown only the importer's own address and no
    /// existing space at all (`emails` and `space_names` are filled that way by the caller), and every
    /// other address in the archive is withheld: matching it would pour messages into a stranger's
    /// account, and creating a waiting account under it would lock that stranger out of registering
    /// (an address held by a waiting account can only be claimed through an invitation).
    pub scoped: bool,
    /// The importer's own address, so the plan can say they are already in a space they create
    /// (they own it, whatever the archive lists them as).
    pub importer_email: String,
    /// What the spaces here hold in people and seats, for the people block of the plan. Filled for an
    /// instance administrator only: a scoped import creates spaces and fills none.
    pub space_people: Vec<SpacePeople>,
}

/// The people and seats of the spaces here that share one name (names are what the run matches on).
#[derive(Debug, Clone, Default)]
pub struct SpacePeople {
    pub name_folded: String,
    /// Addresses of the people already in the space.
    pub emails: Vec<String>,
    /// Owners and members: what the seats count.
    pub seats_used: u32,
    /// The seats sold, for a space whose entitlement is licensed (live or frozen); `None` otherwise.
    pub seats: Option<u32>,
    /// Whether an import may still create custom roles there (a licence that is live).
    pub custom_roles_allowed: bool,
    /// Several spaces carry this name: the run refuses it, and the plan shows no seats for it.
    pub ambiguous: bool,
    /// Addresses of the people who are guests of the space already (kept as they are).
    pub guest_emails: Vec<String>,
    /// The people in each channel of the space already, as (channel name, addresses): an adopted
    /// channel keeps their place there, so they are never written a moderator.
    pub channel_members: Vec<(String, Vec<String>)>,
}

pub fn build(index: &Index, existing: &Existing) -> Plan {
    let source = index
        .manifest
        .as_ref()
        .map(|m| m.source.clone())
        .unwrap_or_default();
    let limits = index
        .manifest
        .as_ref()
        .map(|m| m.limits.clone())
        .unwrap_or_default();

    let known_spaces: Vec<String> = existing
        .space_names
        .iter()
        .map(|n| n.trim().to_lowercase())
        .collect();

    // Handles here, per space name, both folded the way the run folds them.
    let mut here: HashMap<String, Vec<String>> = HashMap::new();
    for (space, channel) in &existing.channels {
        here.entry(space.trim().to_lowercase())
            .or_default()
            .push(channel.clone());
    }

    let mut conversations: HashMap<&str, (usize, usize)> = HashMap::new();
    for channel in &index.channels {
        let entry = conversations
            .entry(channel.space.as_str())
            .or_insert((0, 0));
        if channel.kind == "direct" {
            entry.1 += 1;
        } else {
            entry.0 += 1;
        }
    }

    let spaces = index
        .spaces
        .iter()
        .map(|space| {
            let (channels, directs) = conversations
                .get(space.id.as_str())
                .copied()
                .unwrap_or((0, 0));
            let name_here = space.name.trim().to_lowercase();
            let filled = known_spaces.contains(&name_here);
            // Only a space that is filled can meet a channel of its own name. A created one is
            // empty by construction, whatever else the instance holds.
            let channels_filled = if filled {
                let handles = here.get(&name_here);
                index
                    .channels
                    .iter()
                    .filter(|channel| channel.space == space.id && channel.kind != "direct")
                    .filter(|channel| {
                        let handle = crate::messaging::slug::slugify(&channel.name);
                        handles.is_some_and(|names| names.contains(&handle))
                    })
                    .count()
            } else {
                0
            };
            SpacePlan {
                source_id: space.id.clone(),
                name: space.name.clone(),
                description: space.description.clone(),
                outcome: if filled {
                    SpaceOutcome::Filled
                } else {
                    SpaceOutcome::Created
                },
                channels,
                directs,
                channels_filled,
            }
        })
        .collect();

    let accounts = index
        .users
        .iter()
        .map(|user| {
            let (email, outcome) = account_outcome(&user.email, existing);
            AccountPlan {
                source_id: user.id.clone(),
                display_name: user.display_name.clone(),
                email,
                active: user.active,
                outcome,
                skipped: false,
            }
        })
        .collect();

    Plan {
        source,
        spaces,
        accounts,
        messages: index.message_count,
        files: index.files.len(),
        bytes: index.files.iter().map(|f| f.size).sum(),
        limits,
    }
}

// --- the people block -------------------------------------------------------------------------

/// Roles an archive gives that this server cannot create, and the fixed role they fall back to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFallback {
    pub role: String,
    /// `member` or `admin`.
    pub fixed: String,
    pub people: usize,
}

/// One filled, licensed space: its seats now, what arrives, and whether that is too many.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatsLine {
    pub space: String,
    pub used: u32,
    pub incoming: u32,
    pub total: u32,
    pub over: bool,
}

/// Who arrives with which role, and what it costs in seats. Pure, like the plan itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeoplePlan {
    pub administrators: usize,
    pub guests: usize,
    pub moderators: usize,
    pub groups: Vec<String>,
    /// Names of the people who are in their space already; their role is never changed.
    pub already_here: Vec<String>,
    pub fallbacks: Vec<PlannedFallback>,
    pub seats: Vec<SeatsLine>,
    pub custom_roles: usize,
}

/// What the archive says about people, set against what the instance holds.
///
/// Skipped people are left out altogether. A person already in the space (matched on their
/// address, or the importer in a space they create) keeps their role and is neither an
/// administrator, a guest nor a seat. A space the import creates never has a licence, so it has no
/// seats line and its custom roles fall back (a created space has none to be licensed by).
pub fn people_plan(index: &Index, plan: &Plan, existing: &Existing) -> PeoplePlan {
    let account: HashMap<&str, &AccountPlan> = plan
        .accounts
        .iter()
        .map(|a| (a.source_id.as_str(), a))
        .collect();
    let roles: HashMap<(&str, &str), &super::archive::RoleRecord> = index
        .roles
        .iter()
        .map(|r| ((r.space.as_str(), r.id.as_str()), r))
        .collect();
    let importer = existing.importer_email.trim().to_lowercase();

    let mut out = PeoplePlan::default();
    let mut fallbacks: Vec<PlannedFallback> = Vec::new();
    for group in &index.groups {
        out.groups.push(group.name.clone());
    }

    for space in &plan.spaces {
        let is_filled = space.outcome == SpaceOutcome::Filled;
        let here = if is_filled {
            let folded = space.name.trim().to_lowercase();
            existing
                .space_people
                .iter()
                .find(|p| p.name_folded == folded)
        } else {
            None
        };
        let space_id = space.source_id.as_str();

        // Everyone the archive puts in this space, with the role it gives them.
        let mut role_of: Vec<(&str, &str, &[String])> = Vec::new();
        let mut listed: HashSet<&str> = HashSet::new();
        for line in index.members.iter().filter(|m| m.space == space_id) {
            if listed.insert(line.user.as_str()) {
                role_of.push((line.user.as_str(), line.role.as_str(), &line.roles));
            }
        }
        // Anyone in a conversation or a group of the space but on no line is admitted as a member.
        let mut also: Vec<&str> = Vec::new();
        for channel in index.channels.iter().filter(|c| c.space == space_id) {
            also.extend(channel.members.iter().map(String::as_str));
        }
        for group in index.groups.iter().filter(|g| g.space == space_id) {
            also.extend(group.members.iter().map(String::as_str));
        }
        for user in also {
            if listed.insert(user) {
                role_of.push((user, "member", &[]));
            }
        }

        let mut incoming: u32 = 0;
        let mut used_roles: HashSet<&str> = HashSet::new();
        for (user, role, held) in &role_of {
            let Some(person) = account.get(user) else {
                continue;
            };
            if person.skipped {
                continue;
            }
            let email = person.email.trim().to_lowercase();
            let in_already = !email.is_empty()
                && if is_filled {
                    here.is_some_and(|h| h.emails.iter().any(|e| e.to_lowercase() == email))
                } else {
                    email == importer
                };
            if in_already {
                if !out.already_here.contains(&person.display_name) {
                    out.already_here.push(person.display_name.clone());
                }
                continue;
            }
            match *role {
                "admin" => out.administrators += 1,
                "guest" => out.guests += 1,
                _ => {}
            }
            if *role != "guest" {
                incoming += 1;
                for id in *held {
                    let Some(record) = roles.get(&(space_id, id.as_str())) else {
                        continue;
                    };
                    if here.is_some_and(|h| h.custom_roles_allowed) {
                        used_roles.insert(id.as_str());
                    } else {
                        let fixed = if record.based_on == "admin" {
                            "admin"
                        } else {
                            "member"
                        };
                        match fallbacks
                            .iter_mut()
                            .find(|f| f.role == record.name && f.fixed == fixed)
                        {
                            Some(found) => found.people += 1,
                            None => fallbacks.push(PlannedFallback {
                                role: record.name.clone(),
                                fixed: fixed.to_owned(),
                                people: 1,
                            }),
                        }
                    }
                }
            }
        }
        out.custom_roles += used_roles.len();

        // Moderators, counted the way the run writes them: one per channel membership it writes,
        // so never a guest of the space (listed as one, or already one here) and never somebody
        // who is in an adopted channel already (they keep their place in it).
        let folded_in =
            |emails: &[String], email: &str| emails.iter().any(|e| e.to_lowercase() == email);
        let listed_guest: HashSet<&str> = role_of
            .iter()
            .filter(|(_, role, _)| *role == "guest")
            .map(|(user, _, _)| *user)
            .collect();
        for channel in index
            .channels
            .iter()
            .filter(|c| c.space == space_id && c.kind != "direct")
        {
            let handle = crate::messaging::slug::slugify(&channel.name);
            let adopted_members: Option<&[String]> = here.and_then(|h| {
                existing
                    .channels
                    .iter()
                    .any(|(s, c)| {
                        s.trim().to_lowercase() == space.name.trim().to_lowercase() && *c == handle
                    })
                    .then(|| {
                        h.channel_members
                            .iter()
                            .find(|(name, _)| *name == handle)
                            .map_or(&[][..], |(_, emails)| emails.as_slice())
                    })
            });
            for moderator in &channel.moderators {
                if !channel.members.contains(moderator) {
                    continue;
                }
                let Some(person) = account.get(moderator.as_str()).filter(|a| !a.skipped) else {
                    continue;
                };
                let email = person.email.trim().to_lowercase();
                let in_space =
                    !email.is_empty() && here.is_some_and(|h| folded_in(&h.emails, &email));
                let guest = if in_space {
                    here.is_some_and(|h| folded_in(&h.guest_emails, &email))
                } else {
                    listed_guest.contains(moderator.as_str())
                };
                let in_channel = !email.is_empty()
                    && adopted_members.is_some_and(|members| folded_in(members, &email));
                if super::people::writes_moderator(true, guest, in_channel) {
                    out.moderators += 1;
                }
            }
        }

        if let Some(h) = here {
            if let (Some(total), false) = (h.seats, h.ambiguous) {
                out.seats.push(SeatsLine {
                    space: space.name.clone(),
                    used: h.seats_used,
                    incoming,
                    total,
                    over: h.seats_used + incoming > total,
                });
            }
        }
    }
    out.fallbacks = fallbacks;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::archive::{ChannelRecord, Manifest, SpaceRecord, UserRecord};

    pub(super) fn index_with(
        users: Vec<UserRecord>,
        spaces: Vec<SpaceRecord>,
        channels: Vec<ChannelRecord>,
    ) -> Index {
        Index {
            manifest: Some(Manifest {
                format_version: 1,
                source: "mattermost".into(),
                source_version: String::new(),
                producer: "test".into(),
                created_at: String::new(),
                counts: Default::default(),
                checksums: Default::default(),
                limits: vec!["archived channels do not come out".into()],
            }),
            users,
            spaces,
            channels,
            ..Default::default()
        }
    }

    pub(super) fn user(id: &str, email: &str) -> UserRecord {
        UserRecord {
            id: id.into(),
            email: email.into(),
            display_name: id.into(),
            active: true,
        }
    }

    pub(super) fn space(id: &str, name: &str) -> SpaceRecord {
        SpaceRecord {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            visibility: "public".into(),
        }
    }

    pub(super) fn channel(id: &str, space: &str, kind: &str) -> ChannelRecord {
        ChannelRecord {
            id: id.into(),
            space: space.into(),
            kind: kind.into(),
            name: id.into(),
            topic: String::new(),
            visibility: "public".into(),
            archived: false,
            members: vec![],
            member_state: vec![],
            created_at: None,
            moderators: vec![],
        }
    }

    #[test]
    fn an_address_we_already_know_is_the_same_person() {
        let index = index_with(vec![user("alice", "alice@example.org")], vec![], vec![]);
        let existing = Existing {
            emails: vec!["alice@example.org".into()],
            ..Default::default()
        };
        assert_eq!(
            build(&index, &existing).accounts[0].outcome,
            AccountOutcome::Matched
        );
    }

    #[test]
    fn the_case_of_an_address_does_not_make_a_second_person() {
        let index = index_with(vec![user("alice", "Alice@Example.ORG")], vec![], vec![]);
        let existing = Existing {
            emails: vec!["alice@example.org".into()],
            ..Default::default()
        };
        assert_eq!(
            build(&index, &existing).accounts[0].outcome,
            AccountOutcome::Matched
        );
    }

    #[test]
    fn an_unknown_address_can_be_invited() {
        let index = index_with(vec![user("bob", "bob@example.org")], vec![], vec![]);
        let plan = build(&index, &Existing::default());
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::Invited);
        assert!(plan.anyone_reachable_by_mail());
    }

    #[test]
    fn no_address_means_a_decision_rather_than_a_guess() {
        // The Nextcloud fixture is six accounts out of six in this state. Matching them on their
        // display name would eventually hand one person's messages to another.
        let index = index_with(vec![user("carol", "")], vec![], vec![]);
        let plan = build(&index, &Existing::default());
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::NeedsDecision);
        assert!(!plan.anyone_reachable_by_mail());
    }

    #[test]
    fn a_blank_address_is_not_an_address() {
        let index = index_with(vec![user("carol", "   ")], vec![], vec![]);
        assert_eq!(
            build(&index, &Existing::default()).accounts[0].outcome,
            AccountOutcome::NeedsDecision
        );
    }

    #[test]
    fn a_space_we_already_have_is_filled_rather_than_created() {
        let index = index_with(vec![], vec![space("atelier", "Atelier")], vec![]);
        let existing = Existing {
            space_names: vec!["atelier".into()],
            ..Default::default()
        };
        assert_eq!(
            build(&index, &existing).spaces[0].outcome,
            SpaceOutcome::Filled
        );
    }

    /// A conversation of a space being filled can already be here, and then it is not created a
    /// second time: it takes the archive's history. The plan says so before the run, because a
    /// merge nobody was shown is a merge nobody agreed to.
    #[test]
    fn a_conversation_that_is_already_here_is_announced_as_taking_the_history() {
        let index = index_with(
            vec![],
            vec![space("atelier", "Atelier")],
            vec![
                channel("Général", "atelier", "channel"),
                channel("Produit", "atelier", "channel"),
                channel("direct-1", "atelier", "direct"),
            ],
        );
        let existing = Existing {
            space_names: vec!["Atelier".into()],
            // The handle, as the run folds it: "Général" is `general` here.
            channels: vec![("Atelier".into(), "general".into())],
            ..Default::default()
        };

        let plan = build(&index, &existing);
        assert_eq!(plan.spaces[0].outcome, SpaceOutcome::Filled);
        assert_eq!(plan.spaces[0].channels, 2);
        assert_eq!(plan.spaces[0].channels_filled, 1);
    }

    /// A space being created meets nothing: it is empty, whatever the rest of the instance holds.
    #[test]
    fn a_conversation_of_a_space_that_is_created_is_never_announced_as_filled() {
        let index = index_with(
            vec![],
            vec![space("atelier", "Atelier")],
            vec![channel("Général", "atelier", "channel")],
        );
        let existing = Existing {
            channels: vec![("Ailleurs".into(), "general".into())],
            ..Default::default()
        };

        let plan = build(&index, &existing);
        assert_eq!(plan.spaces[0].outcome, SpaceOutcome::Created);
        assert_eq!(plan.spaces[0].channels_filled, 0);
    }

    #[test]
    fn a_space_nobody_has_is_created() {
        let index = index_with(vec![], vec![space("atelier", "Atelier")], vec![]);
        let plan = build(&index, &Existing::default());
        assert_eq!(plan.spaces[0].outcome, SpaceOutcome::Created);
        assert_eq!(plan.spaces_created(), 1);
    }

    #[test]
    fn conversations_are_counted_per_space_and_by_kind() {
        let index = index_with(
            vec![],
            vec![space("atelier", "Atelier"), space("direction", "Direction")],
            vec![
                channel("a1", "atelier", "channel"),
                channel("a2", "atelier", "channel"),
                channel("a3", "atelier", "direct"),
                channel("d1", "direction", "channel"),
            ],
        );
        let plan = build(&index, &Existing::default());
        let atelier = plan
            .spaces
            .iter()
            .find(|s| s.source_id == "atelier")
            .unwrap();
        assert_eq!((atelier.channels, atelier.directs), (2, 1));
        let direction = plan
            .spaces
            .iter()
            .find(|s| s.source_id == "direction")
            .unwrap();
        assert_eq!((direction.channels, direction.directs), (1, 0));
    }

    #[test]
    fn the_producers_own_words_are_carried_through_unchanged() {
        // Summarising a declared loss is another way of hiding it.
        let index = index_with(vec![], vec![], vec![]);
        assert_eq!(
            build(&index, &Existing::default()).limits,
            vec!["archived channels do not come out".to_string()]
        );
    }

    #[test]
    fn an_archive_with_no_manifest_still_produces_a_plan() {
        // Refusing happens in the checks, with a reason. The plan does not get to panic on the way.
        let plan = build(&Index::default(), &Existing::default());
        assert!(plan.source.is_empty());
        assert!(plan.spaces.is_empty());
    }
}

#[cfg(test)]
mod choice_tests {
    use super::tests::*;
    use super::*;

    /// The common case, and the one the whole editable list exists for: an export that carried
    /// somebody without an address, and an administrator who knows it.
    #[test]
    fn an_address_given_by_hand_turns_somebody_undecidable_into_somebody_invitable() {
        let index = index_with(vec![user("alice", "")], vec![], vec![]);
        let existing = Existing::default();
        let mut plan = build(&index, &existing);
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::NeedsDecision);

        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "alice".into(),
                email: Some("alice@example.test".into()),
                skip: false,
            }],
            &existing,
        );
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::Invited);
        assert_eq!(plan.accounts[0].email, "alice@example.test");
    }

    /// An address typed by hand can name somebody who is already here, and that is a match, not a
    /// second account for the same person.
    #[test]
    fn an_address_that_belongs_to_an_account_here_matches_it() {
        let index = index_with(vec![user("alice", "")], vec![], vec![]);
        let existing = Existing {
            emails: vec!["alice@example.test".into()],
            ..Default::default()
        };
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "alice".into(),
                email: Some("  Alice@Example.test  ".into()),
                skip: false,
            }],
            &existing,
        );
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::Matched);
        assert_eq!(plan.accounts[0].email, "Alice@Example.test");
    }

    #[test]
    fn an_address_taken_back_leaves_the_person_undecidable_again() {
        let index = index_with(vec![user("alice", "alice@example.test")], vec![], vec![]);
        let existing = Existing::default();
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "alice".into(),
                email: Some("   ".into()),
                skip: false,
            }],
            &existing,
        );
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::NeedsDecision);
    }

    #[test]
    fn somebody_left_out_is_marked_rather_than_removed() {
        // Removed from the list, the count would quietly change and nobody could put them back.
        let index = index_with(vec![user("alice", "a@example.test")], vec![], vec![]);
        let existing = Existing::default();
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "alice".into(),
                email: None,
                skip: true,
            }],
            &existing,
        );
        assert_eq!(plan.accounts.len(), 1);
        assert!(plan.accounts[0].skipped);
    }

    #[test]
    fn a_choice_about_somebody_this_archive_does_not_carry_changes_nothing() {
        // The plan and the choices can be minutes apart, and refusing the whole import over a name
        // that is no longer there would be a tantrum.
        let index = index_with(vec![user("alice", "a@example.test")], vec![], vec![]);
        let existing = Existing::default();
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "nobody".into(),
                email: Some("x@example.test".into()),
                skip: true,
            }],
            &existing,
        );
        assert!(!plan.accounts[0].skipped);
        assert_eq!(plan.accounts[0].email, "a@example.test");
    }

    #[test]
    fn people_nobody_decided_anything_about_are_left_exactly_as_the_archive_spells_them() {
        let index = index_with(
            vec![
                user("alice", "a@example.test"),
                user("bob", "b@example.test"),
            ],
            vec![],
            vec![],
        );
        let existing = Existing::default();
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "alice".into(),
                email: None,
                skip: true,
            }],
            &existing,
        );
        let bob = plan.accounts.iter().find(|a| a.source_id == "bob").unwrap();
        assert!(!bob.skipped);
        assert_eq!(bob.email, "b@example.test");
    }

    #[test]
    fn a_scoped_import_matches_only_the_importer_and_withholds_every_other_address() {
        let index = index_with(
            vec![
                user("me", "Me@Example.org"),
                user("colleague", "colleague@example.org"),
                user("stranger", "already.here@example.org"),
            ],
            vec![],
            vec![],
        );
        // What a scoped caller passes: its own address only, and no space at all.
        let existing = Existing {
            emails: vec!["me@example.org".into()],
            scoped: true,
            ..Default::default()
        };
        let plan = build(&index, &existing);
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::Matched);
        for account in &plan.accounts[1..] {
            assert_eq!(account.outcome, AccountOutcome::NeedsDecision);
            assert!(
                account.email.is_empty(),
                "{} kept an address",
                account.source_id
            );
        }
    }

    #[test]
    fn a_scoped_import_cannot_hand_somebody_an_address_by_choice() {
        let index = index_with(vec![user("a", "")], vec![], vec![]);
        let existing = Existing {
            emails: vec!["me@example.org".into()],
            scoped: true,
            ..Default::default()
        };
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "a".into(),
                email: Some("victim@example.org".into()),
                skip: false,
            }],
            &existing,
        );
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::NeedsDecision);
        assert!(plan.accounts[0].email.is_empty());

        // Their own address is the one that still works: it is how an importer says "that is me".
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "a".into(),
                email: Some("me@example.org".into()),
                skip: false,
            }],
            &existing,
        );
        assert_eq!(plan.accounts[0].outcome, AccountOutcome::Matched);
    }
}

/// What the plan says about the people (format 2): who arrives with which role, and the seats.
#[cfg(test)]
mod people_plan_tests {
    use super::tests::{channel, index_with, space, user};
    use super::*;
    use crate::importer::archive::{GroupRecord, MemberRecord, RoleRecord};

    fn line(space: &str, user: &str, role: &str, roles: &[&str]) -> MemberRecord {
        MemberRecord {
            space: space.into(),
            user: user.into(),
            role: role.into(),
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
        }
    }

    fn licensed(name: &str, used: u32, total: u32, emails: &[&str]) -> SpacePeople {
        SpacePeople {
            name_folded: name.to_lowercase(),
            emails: emails.iter().map(|e| (*e).to_owned()).collect(),
            seats_used: used,
            seats: Some(total),
            custom_roles_allowed: true,
            ambiguous: false,
            ..Default::default()
        }
    }

    /// One space "Atelier" and `n` accounts u0..un with addresses, none of them placed yet.
    fn archive(n: usize) -> Index {
        let users = (0..n)
            .map(|i| user(&format!("u{i}"), &format!("u{i}@example.org")))
            .collect();
        index_with(users, vec![space("atelier", "Atelier")], vec![])
    }

    fn filled(people: Vec<SpacePeople>) -> Existing {
        Existing {
            space_names: vec!["Atelier".into()],
            space_people: people,
            ..Default::default()
        }
    }

    fn plan_people(index: &Index, existing: &Existing) -> PeoplePlan {
        let plan = build(index, existing);
        people_plan(index, &plan, existing)
    }

    #[test]
    fn administrators_guests_and_moderators_are_counted_per_space() {
        let mut index = archive(5);
        index.spaces.push(space("bureau", "Bureau"));
        index.members = vec![
            line("atelier", "u0", "admin", &[]),
            line("atelier", "u1", "guest", &[]),
            line("atelier", "u2", "member", &[]),
            line("bureau", "u3", "admin", &[]),
            line("bureau", "u4", "guest", &[]),
        ];
        let mut general = channel("c1", "atelier", "channel");
        general.members = vec!["u0".into(), "u1".into(), "u2".into()];
        // A guest cannot moderate: only u2 counts.
        general.moderators = vec!["u2".into(), "u1".into()];
        index.channels = vec![general];

        let people = plan_people(&index, &Existing::default());
        assert_eq!(people.administrators, 2);
        assert_eq!(people.guests, 2);
        assert_eq!(people.moderators, 1);
        assert!(people.already_here.is_empty());
    }

    #[test]
    fn moderators_are_those_the_run_writes_in_a_channel() {
        let mut index = archive(4);
        index.members = vec![
            line("atelier", "u0", "member", &[]),
            line("atelier", "u1", "member", &[]),
            line("atelier", "u2", "member", &[]),
            line("atelier", "u3", "guest", &[]),
        ];
        let mut general = channel("c1", "atelier", "channel");
        general.name = "general".into();
        general.members = vec!["u0".into(), "u1".into(), "u2".into(), "u3".into()];
        general.moderators = vec!["u0".into(), "u1".into(), "u2".into(), "u3".into()];
        index.channels = vec![general];
        // u1 is a guest of the space already, u2 is in the adopted channel already.
        let existing = Existing {
            space_names: vec!["Atelier".into()],
            channels: vec![("Atelier".into(), "general".into())],
            space_people: vec![SpacePeople {
                name_folded: "atelier".into(),
                emails: vec!["u1@example.org".into(), "u2@example.org".into()],
                guest_emails: vec!["u1@example.org".into()],
                channel_members: vec![("general".into(), vec!["u2@example.org".into()])],
                ..Default::default()
            }],
            ..Default::default()
        };
        // Only u0 is written a moderator: u1 is a guest, u2 keeps their place, u3 is listed a guest.
        assert_eq!(plan_people(&index, &existing).moderators, 1);
        // A space the import creates has nobody in it yet: only the guest listed as one stays out.
        let created = Existing::default();
        assert_eq!(plan_people(&index, &created).moderators, 3);
    }

    #[test]
    fn a_person_already_in_the_space_keeps_their_role_and_takes_no_seat() {
        let mut index = archive(3);
        index.members = vec![
            line("atelier", "u0", "admin", &[]),
            line("atelier", "u1", "guest", &[]),
            line("atelier", "u2", "member", &[]),
        ];
        // u0 is in the space already: their role stays, they are neither an arrival nor a seat.
        let existing = filled(vec![licensed("atelier", 5, 25, &["U0@example.org"])]);
        let people = plan_people(&index, &existing);
        assert_eq!(people.administrators, 0);
        assert_eq!(people.already_here, vec!["u0".to_owned()]);
        assert_eq!(people.guests, 1);
        assert_eq!(people.seats[0].incoming, 1);
    }

    #[test]
    fn guests_take_no_seat() {
        let mut index = archive(3);
        index.members = vec![
            line("atelier", "u0", "guest", &[]),
            line("atelier", "u1", "guest", &[]),
            line("atelier", "u2", "member", &[]),
        ];
        let people = plan_people(&index, &filled(vec![licensed("atelier", 0, 10, &[])]));
        assert_eq!(people.seats[0].incoming, 1);
    }

    #[test]
    fn the_importer_is_already_there_in_a_created_space() {
        let mut index = archive(2);
        index.members = vec![
            line("atelier", "u0", "guest", &[]),
            line("atelier", "u1", "admin", &[]),
        ];
        let existing = Existing {
            importer_email: "u0@example.org".into(),
            ..Default::default()
        };
        let people = plan_people(&index, &existing);
        assert_eq!(people.already_here, vec!["u0".to_owned()]);
        assert_eq!(
            people.guests, 0,
            "the importer owns the space, whatever the archive says"
        );
        assert_eq!(people.administrators, 1);
    }

    #[test]
    fn a_created_space_has_no_seats_line() {
        let mut index = archive(2);
        index.members = vec![line("atelier", "u0", "member", &[])];
        // A licence exists for a space of that name elsewhere; this one is created, so it has none.
        let existing = Existing {
            space_names: vec!["Ailleurs".into()],
            space_people: vec![licensed("atelier", 1, 2, &[])],
            ..Default::default()
        };
        assert!(plan_people(&index, &existing).seats.is_empty());
    }

    #[test]
    fn a_filled_licensed_space_gets_its_seats_line() {
        let mut index = archive(11);
        index.members = (0..11)
            .map(|i| line("atelier", &format!("u{i}"), "member", &[]))
            .collect();
        let people = plan_people(&index, &filled(vec![licensed("atelier", 1, 25, &[])]));
        assert_eq!(
            people.seats,
            vec![SeatsLine {
                space: "Atelier".into(),
                used: 1,
                incoming: 11,
                total: 25,
                over: false
            }]
        );
    }

    #[test]
    fn over_the_seats_is_flagged_with_the_missing_count() {
        let mut index = archive(11);
        index.members = (0..11)
            .map(|i| line("atelier", &format!("u{i}"), "member", &[]))
            .collect();
        let people = plan_people(&index, &filled(vec![licensed("atelier", 10, 20, &[])]));
        let seats = &people.seats[0];
        assert!(seats.over);
        assert_eq!(seats.used + seats.incoming - seats.total, 1);
    }

    #[test]
    fn a_skipped_person_takes_no_seat() {
        let mut index = archive(3);
        index.members = (0..3)
            .map(|i| line("atelier", &format!("u{i}"), "admin", &[]))
            .collect();
        let existing = filled(vec![licensed("atelier", 0, 10, &[])]);
        let mut plan = build(&index, &existing);
        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "u1".into(),
                email: None,
                skip: true,
            }],
            &existing,
        );
        let people = people_plan(&index, &plan, &existing);
        assert_eq!(people.seats[0].incoming, 2);
        assert_eq!(people.administrators, 2);
    }

    #[test]
    fn an_address_given_by_hand_can_turn_a_new_person_into_one_already_here() {
        let mut index = archive(1);
        index.users.push(user("nomail", ""));
        index.members = vec![
            line("atelier", "u0", "member", &[]),
            line("atelier", "nomail", "member", &[]),
        ];
        let existing = filled(vec![licensed("atelier", 3, 10, &["known@example.org"])]);
        let mut plan = build(&index, &existing);
        let before = people_plan(&index, &plan, &existing);
        assert_eq!(before.seats[0].incoming, 2);
        assert!(before.already_here.is_empty());

        apply_choices(
            &mut plan,
            &[PersonChoice {
                source_id: "nomail".into(),
                email: Some("known@example.org".into()),
                skip: false,
            }],
            &existing,
        );
        let after = people_plan(&index, &plan, &existing);
        assert_eq!(after.already_here, vec!["nomail".to_owned()]);
        assert_eq!(after.seats[0].incoming, 1);
    }

    #[test]
    fn a_custom_role_in_an_unlicensed_space_is_a_fallback() {
        let mut index = archive(3);
        index.roles = vec![RoleRecord {
            id: "r1".into(),
            space: "atelier".into(),
            name: "Moderators".into(),
            based_on: "admin".into(),
        }];
        index.members = vec![
            line("atelier", "u0", "member", &["r1"]),
            line("atelier", "u1", "member", &["r1"]),
            line("atelier", "u2", "guest", &["r1"]),
        ];
        let people = plan_people(&index, &Existing::default());
        assert_eq!(people.custom_roles, 0);
        assert_eq!(
            people.fallbacks,
            vec![PlannedFallback {
                role: "Moderators".into(),
                fixed: "admin".into(),
                people: 2
            }],
            "a guest ignores roles, so does not count"
        );

        // The same archive in a licensed filled space creates the role.
        let licensed_here = plan_people(&index, &filled(vec![licensed("atelier", 0, 10, &[])]));
        assert_eq!(licensed_here.custom_roles, 1);
        assert!(licensed_here.fallbacks.is_empty());
    }

    #[test]
    fn a_group_member_listed_nowhere_counts_one_seat() {
        let mut index = archive(3);
        index.members = vec![line("atelier", "u0", "member", &[])];
        index.groups = vec![GroupRecord {
            id: "g1".into(),
            space: "atelier".into(),
            name: "Design".into(),
            description: String::new(),
            members: vec!["u0".into(), "u1".into()],
        }];
        let people = plan_people(&index, &filled(vec![licensed("atelier", 0, 10, &[])]));
        assert_eq!(people.seats[0].incoming, 2);
        assert_eq!(people.groups, vec!["Design".to_owned()]);
    }

    #[test]
    fn an_ambiguous_space_name_shows_no_seats_line() {
        let mut index = archive(1);
        index.members = vec![line("atelier", "u0", "member", &[])];
        let mut here = licensed("atelier", 1, 5, &[]);
        here.ambiguous = true;
        assert!(plan_people(&index, &filled(vec![here])).seats.is_empty());
    }
}
