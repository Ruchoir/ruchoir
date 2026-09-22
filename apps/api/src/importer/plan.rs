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

use std::collections::HashMap;

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
            let email = email.trim();
            account.email = email.to_owned();
            account.outcome = if email.is_empty() {
                AccountOutcome::NeedsDecision
            } else if existing.emails.contains(&email.to_lowercase()) {
                AccountOutcome::Matched
            } else {
                AccountOutcome::Invited
            };
        }
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

    // Addresses are compared case-insensitively: the same person writes theirs in whichever case
    // they feel like, and two accounts differing only in case are one person, not two.
    let known: Vec<String> = existing.emails.iter().map(|e| e.to_lowercase()).collect();
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
            let email = user.email.trim().to_string();
            let outcome = if email.is_empty() {
                AccountOutcome::NeedsDecision
            } else if known.contains(&email.to_lowercase()) {
                AccountOutcome::Matched
            } else {
                AccountOutcome::Invited
            };
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
}
