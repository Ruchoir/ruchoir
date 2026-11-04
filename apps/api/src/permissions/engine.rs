//! Resolution: from a person's standing, roles and the rules on a resource to what they may do.
//!
//! Pure: no I/O, so every case is a unit test. The loader (`load.rs`) gathers the facts and
//! the rules; this module only decides, and records why when asked, through the same code path,
//! so an explanation can never disagree with the decision.
//!
//! The order (spec section 2, with lot 1's private lock):
//!
//! 1. An owner holds everything, whatever the rules (an archived channel stays read only).
//! 2. The base role and every role held add up. A guest then loses the space-wide visibility and
//!    everything above the ceiling.
//! 3. On a channel, a membership row admits (a guest included).
//! 4. Each level of the chain, from the top down to the resource: rules on the base role (deny,
//!    then allow), on the person's roles (union of denies, then union of allows), on the person
//!    (deny, then allow). The level closest to the resource comes last, so it wins.
//!    Groups and the readers of a channel sit beside the roles: all their denies, then all their
//!    allows.
//! 5. A private channel nobody joined stays closed. Joining opens one, and so does an allow of
//!    `channel.view` on the channel from a group, a person or a custom role (`Rule::lifts_lock`),
//!    unless a later rule takes the view away again. A converted reservation is an allow on the
//!    Administrator role, and it must not let an administrator read a private room they never
//!    entered: the base roles and the Administrator role never lift the lock.
//! 6. The guest ceiling again: no rule makes a guest a moderator.
//! 7. A file's author manages it (and, unless a guest, may publish a link to it); an archived
//!    channel takes writing away.

use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::system_roles::{GUEST_CEILING, VISIBILITY_DROP};

/// Where a person stands in a space. Not a role: it decides which base role applies, and an owner
/// stands outside every rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Owner,
    Member,
    Guest,
}

/// Who a rule is about, already matched to the subject by the loader: a rule the loader hands over
/// always applies to the person being resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRef {
    /// The base role (`@members` or `@guests`, whichever the standing implies).
    BaseRole,
    /// One of the roles the person holds.
    Role(Uuid),
    /// The person themselves.
    User,
    /// A group the person belongs to.
    Group(Uuid),
    /// The readers of a channel, the person among them (files and folders only).
    Audience(Uuid),
}

/// What opened a private channel nobody joined: a rule aimed at a role, a group or the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opener {
    Role(Uuid),
    Group(Uuid),
    User,
}

/// What a trace line names as the reason for a change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Role(Uuid),
    BaseRole,
    /// The person's role inside a channel (`owner`, `admin`).
    ChannelRole(&'static str),
    User,
    Group(Uuid),
    Audience(Uuid),
    /// The private lock of a channel, lifted by a rule: a trace line only, nothing changes.
    Lifted(Opener),
    /// A fact rather than a rule: `owner`, `guest`, `joined`, `private`, `author`, `archived`.
    Implicit(&'static str),
}

/// Whom a rule is about while a preview is on: the previewed role's standing, the viewer's own, or
/// both. Always `Both` when nothing is previewed. The loader tags, `check::resolved` filters: the
/// preview resolves with the first two kinds and the viewer's ceiling with the last two.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Whom {
    Both,
    Preview,
    Viewer,
}

/// One rule on a resource: what it adds and what it removes for its target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub target: TargetRef,
    pub allow: PermissionSet,
    pub deny: PermissionSet,
    pub source: Source,
    /// Whether an allow of `channel.view` from this rule opens a private channel nobody joined:
    /// true for a group, a person and a custom role, false for the base roles, the Administrator
    /// role, a channel role and the readers of a channel.
    pub lifts_lock: bool,
    pub whom: Whom,
}

/// What kind of resource a level of the chain is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LevelKind {
    Channel,
    Folder,
    File,
    Calendar,
}

/// One step of the chain from the space down to a resource, with the rules set on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Level {
    pub kind: LevelKind,
    pub id: Uuid,
    pub rules: Vec<Rule>,
}

/// Facts about the person and the resource that are not rules. All false when not applicable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub private_channel: bool,
    pub joined: bool,
    pub archived: bool,
    pub author: bool,
}

/// The person being resolved: their standing, their base role's permissions and each role held.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    pub standing: Standing,
    pub base: PermissionSet,
    pub roles: Vec<(Uuid, PermissionSet)>,
}

/// Whether a trace step gave or took a permission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Granted,
    Removed,
}

/// One line of an explanation: a permission that changed, how, because of what, and where.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub permission: Permission,
    pub effect: Effect,
    pub source: Source,
    pub level: Option<(LevelKind, Uuid)>,
}

/// The outcome: what is granted, and (in explain mode) every change on the way, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Decision {
    pub granted: PermissionSet,
    pub trace: Vec<Step>,
}

/// The set being built, and the trace of how, when one is asked for.
struct Run {
    granted: PermissionSet,
    trace: Option<Vec<Step>>,
}

impl Run {
    fn add(
        &mut self,
        permissions: PermissionSet,
        source: Source,
        level: Option<(LevelKind, Uuid)>,
    ) {
        let added = permissions.minus(self.granted);
        self.granted = self.granted.union(permissions);
        self.record(added, Effect::Granted, source, level);
    }

    fn take(
        &mut self,
        permissions: PermissionSet,
        source: Source,
        level: Option<(LevelKind, Uuid)>,
    ) {
        let removed = permissions.intersect(self.granted);
        self.granted = self.granted.minus(permissions);
        self.record(removed, Effect::Removed, source, level);
    }

    fn record(
        &mut self,
        changed: PermissionSet,
        effect: Effect,
        source: Source,
        level: Option<(LevelKind, Uuid)>,
    ) {
        if let Some(trace) = self.trace.as_mut() {
            trace.extend(changed.iter().map(|permission| Step {
                permission,
                effect,
                source,
                level,
            }));
        }
    }
}

const WRITING: PermissionSet =
    PermissionSet::of(&[Permission::MessageSend, Permission::MessageAttach]);
const CHANNEL_VIEW: PermissionSet = PermissionSet::of(&[Permission::ChannelView]);

/// Decide what `subject` may do on the resource at the bottom of `chain` (an empty chain is the
/// space itself). With `explain`, the decision carries every change in the order it happened.
pub fn resolve(subject: &Subject, chain: &[Level], facts: Facts, explain: bool) -> Decision {
    let mut run = Run {
        granted: PermissionSet::EMPTY,
        trace: explain.then(Vec::new),
    };
    let channel = chain.iter().find(|level| level.kind == LevelKind::Channel);
    if subject.standing == Standing::Owner {
        run.add(PermissionSet::ALL, Source::Implicit("owner"), None);
        // An archived room is read only for its space's owner too: a property, not a rule.
        if facts.archived {
            run.take(
                WRITING,
                Source::Implicit("archived"),
                channel.map(|c| (c.kind, c.id)),
            );
        }
        return Decision {
            granted: run.granted,
            trace: run.trace.unwrap_or_default(),
        };
    }
    let guest = subject.standing == Standing::Guest;

    run.add(subject.base, Source::BaseRole, None);
    for (role, permissions) in &subject.roles {
        run.add(*permissions, Source::Role(*role), None);
    }
    if guest {
        run.take(VISIBILITY_DROP, Source::Implicit("guest"), None);
        run.take(GUEST_CEILING, Source::Implicit("guest"), None);
    }

    if let Some(channel) = channel {
        if facts.joined {
            run.add(
                CHANNEL_VIEW,
                Source::Implicit("joined"),
                Some((LevelKind::Channel, channel.id)),
            );
        }
    }

    // An allow of the view that opens a private channel, until a later rule takes it away; it
    // remembers which rule did, for the explanation.
    let mut opened: Option<Opener> = None;
    for level in chain {
        let at = Some((level.kind, level.id));
        let of =
            |wanted: fn(&TargetRef) -> bool| level.rules.iter().filter(move |r| wanted(&r.target));
        // Whether a rule's allow of the view opens a private channel, here on the channel itself.
        let lifts = |rule: &Rule| {
            if rule.lifts_lock
                && level.kind == LevelKind::Channel
                && rule.allow.contains(Permission::ChannelView)
            {
                match rule.source {
                    Source::Role(id) => Some(Opener::Role(id)),
                    Source::Group(id) => Some(Opener::Group(id)),
                    Source::User => Some(Opener::User),
                    _ => None,
                }
            } else {
                None
            }
        };
        for rule in of(|t| *t == TargetRef::BaseRole) {
            run.take(rule.deny, rule.source, at);
            run.add(rule.allow, rule.source, at);
            if rule.deny.contains(Permission::ChannelView) {
                opened = None;
            }
            opened = lifts(rule).or(opened);
        }
        let shared: Vec<&Rule> = of(|t| {
            matches!(
                t,
                TargetRef::Role(_) | TargetRef::Group(_) | TargetRef::Audience(_)
            )
        })
        .collect();
        for rule in &shared {
            run.take(rule.deny, rule.source, at);
            if rule.deny.contains(Permission::ChannelView) {
                opened = None;
            }
        }
        for rule in &shared {
            run.add(rule.allow, rule.source, at);
            opened = lifts(rule).or(opened);
        }
        for rule in of(|t| *t == TargetRef::User) {
            run.take(rule.deny, rule.source, at);
            run.add(rule.allow, rule.source, at);
            if rule.deny.contains(Permission::ChannelView) {
                opened = None;
            }
            opened = lifts(rule).or(opened);
        }
    }

    if let Some(channel) = channel {
        if facts.private_channel && !facts.joined {
            let at = Some((LevelKind::Channel, channel.id));
            match opened {
                None => run.take(CHANNEL_VIEW, Source::Implicit("private"), at),
                // The lock stayed open: said in the explanation, the decision is unchanged.
                Some(by) if run.granted.contains(Permission::ChannelView) => {
                    run.record(CHANNEL_VIEW, Effect::Granted, Source::Lifted(by), at)
                }
                Some(_) => {}
            }
        }
    }
    if guest {
        run.take(GUEST_CEILING, Source::Implicit("guest"), None);
    }
    if facts.author {
        let mut own = PermissionSet::of(&[Permission::FilesManage]);
        if !guest {
            own.insert(Permission::FilesPublicLink);
        }
        run.add(
            own,
            Source::Implicit("author"),
            chain.last().map(|l| (l.kind, l.id)),
        );
    }
    if facts.archived {
        run.take(
            WRITING,
            Source::Implicit("archived"),
            channel.map(|c| (c.kind, c.id)),
        );
    }

    Decision {
        granted: run.granted,
        trace: run.trace.unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::catalogue::Permission::*;

    fn set(permissions: &[Permission]) -> PermissionSet {
        PermissionSet::of(permissions)
    }

    fn member(base: &[Permission]) -> Subject {
        Subject {
            standing: Standing::Member,
            base: set(base),
            roles: Vec::new(),
        }
    }

    fn guest(base: &[Permission]) -> Subject {
        Subject {
            standing: Standing::Guest,
            ..member(base)
        }
    }

    fn rule(target: TargetRef, allow: &[Permission], deny: &[Permission]) -> Rule {
        let source = match target {
            TargetRef::BaseRole => Source::BaseRole,
            TargetRef::Role(id) => Source::Role(id),
            TargetRef::User => Source::User,
            TargetRef::Group(id) => Source::Group(id),
            TargetRef::Audience(id) => Source::Audience(id),
        };
        Rule {
            target,
            allow: set(allow),
            deny: set(deny),
            source,
            lifts_lock: false,
            whom: Whom::Both,
        }
    }

    /// A rule as the loader marks it: a group, a person or a custom role lifts the private lock.
    fn lifting(target: TargetRef, allow: &[Permission], deny: &[Permission]) -> Rule {
        Rule {
            lifts_lock: true,
            ..rule(target, allow, deny)
        }
    }

    fn private() -> Facts {
        Facts {
            private_channel: true,
            ..Facts::default()
        }
    }

    fn level(kind: LevelKind, rules: Vec<Rule>) -> Level {
        Level {
            kind,
            id: Uuid::new_v4(),
            rules,
        }
    }

    fn channel(rules: Vec<Rule>) -> Vec<Level> {
        vec![level(LevelKind::Channel, rules)]
    }

    fn joined() -> Facts {
        Facts {
            joined: true,
            ..Facts::default()
        }
    }

    fn granted(subject: &Subject, chain: &[Level], facts: Facts) -> PermissionSet {
        resolve(subject, chain, facts, false).granted
    }

    #[test]
    fn owner_gets_everything_whatever_the_rules() {
        let owner = Subject {
            standing: Standing::Owner,
            base: PermissionSet::EMPTY,
            roles: Vec::new(),
        };
        let chain = channel(vec![
            rule(TargetRef::BaseRole, &[], &Permission::ALL),
            rule(TargetRef::User, &[], &Permission::ALL),
        ]);
        let facts = Facts {
            private_channel: true,
            ..Facts::default()
        };
        assert_eq!(granted(&owner, &chain, facts), PermissionSet::ALL);
    }

    #[test]
    fn base_and_roles_add_up() {
        let mut subject = member(&[ChannelView]);
        subject.roles.push((Uuid::new_v4(), set(&[MembersInvite])));
        subject.roles.push((Uuid::new_v4(), set(&[ChannelsDelete])));
        assert_eq!(
            granted(&subject, &[], Facts::default()),
            set(&[ChannelView, MembersInvite, ChannelsDelete])
        );
    }

    #[test]
    fn a_deny_on_the_base_role_beats_the_base() {
        let subject = member(&[ChannelView, MessageSend]);
        let chain = channel(vec![rule(TargetRef::BaseRole, &[], &[MessageSend])]);
        assert_eq!(
            granted(&subject, &chain, Facts::default()),
            set(&[ChannelView])
        );
    }

    #[test]
    fn a_role_allow_beats_a_base_deny() {
        let role = Uuid::new_v4();
        let mut subject = member(&[ChannelView]);
        subject.roles.push((role, PermissionSet::EMPTY));
        let chain = channel(vec![
            rule(TargetRef::BaseRole, &[], &[ChannelView]),
            rule(TargetRef::Role(role), &[ChannelView], &[]),
        ]);
        assert!(granted(&subject, &chain, Facts::default()).contains(ChannelView));
    }

    #[test]
    fn a_personal_rule_beats_a_role_rule() {
        let role = Uuid::new_v4();
        let mut subject = member(&[ChannelView]);
        subject.roles.push((role, PermissionSet::EMPTY));
        let opened = channel(vec![
            rule(TargetRef::Role(role), &[], &[MessageSend]),
            rule(TargetRef::User, &[MessageSend], &[]),
        ]);
        assert!(granted(&subject, &opened, Facts::default()).contains(MessageSend));
        let closed = channel(vec![
            rule(TargetRef::Role(role), &[MessageSend], &[]),
            rule(TargetRef::User, &[], &[MessageSend]),
        ]);
        assert!(!granted(&subject, &closed, Facts::default()).contains(MessageSend));
    }

    #[test]
    fn the_level_closest_to_the_resource_wins() {
        let subject = member(&[FilesView]);
        let denied = vec![
            level(
                LevelKind::Folder,
                vec![rule(TargetRef::BaseRole, &[FilesEdit], &[])],
            ),
            level(
                LevelKind::File,
                vec![rule(TargetRef::BaseRole, &[], &[FilesEdit])],
            ),
        ];
        assert!(!granted(&subject, &denied, Facts::default()).contains(FilesEdit));
        let allowed = vec![
            level(
                LevelKind::Folder,
                vec![rule(TargetRef::User, &[], &[FilesEdit])],
            ),
            level(
                LevelKind::File,
                vec![rule(TargetRef::BaseRole, &[FilesEdit], &[])],
            ),
        ];
        assert!(granted(&subject, &allowed, Facts::default()).contains(FilesEdit));
    }

    #[test]
    fn a_private_channel_needs_joining() {
        let subject = member(&[ChannelView, MessageSend]);
        let chain = channel(Vec::new());
        let private = Facts {
            private_channel: true,
            ..Facts::default()
        };
        assert!(!granted(&subject, &chain, private).contains(ChannelView));
        let private_joined = Facts {
            joined: true,
            ..private
        };
        assert!(granted(&subject, &chain, private_joined).contains(ChannelView));
        assert!(granted(&subject, &chain, Facts::default()).contains(ChannelView));
    }

    /// Lot 1 keeps today's rule exactly: only joining opens a private channel. A reservation
    /// naming the administrators becomes an allow on that role, and it must not let an
    /// administrator read a private channel they never joined.
    #[test]
    fn an_allow_rule_does_not_open_a_private_channel() {
        let role = Uuid::new_v4();
        let mut subject = member(&[ChannelView]);
        subject.roles.push((role, PermissionSet::ALL));
        let chain = channel(vec![
            rule(TargetRef::BaseRole, &[], &[ChannelView]),
            rule(TargetRef::Role(role), &[ChannelView], &[]),
        ]);
        let private = Facts {
            private_channel: true,
            ..Facts::default()
        };
        assert!(!granted(&subject, &chain, private).contains(ChannelView));
        let private_joined = Facts {
            joined: true,
            ..private
        };
        assert!(granted(&subject, &chain, private_joined).contains(ChannelView));
    }

    #[test]
    fn joining_does_not_beat_a_role_deny() {
        let subject = member(&[ChannelView]);
        let reserved = channel(vec![rule(TargetRef::BaseRole, &[], &[ChannelView])]);
        assert!(!granted(&subject, &reserved, joined()).contains(ChannelView));
        let private_joined = Facts {
            private_channel: true,
            joined: true,
            ..Facts::default()
        };
        assert!(!granted(&subject, &reserved, private_joined).contains(ChannelView));
    }

    #[test]
    fn a_guest_sees_only_where_joined_or_allowed() {
        let subject = guest(&[
            ChannelView,
            FilesView,
            CalendarView,
            MembersView,
            MessageSend,
        ]);
        let chain = channel(Vec::new());
        let unjoined = granted(&subject, &chain, Facts::default());
        assert!(!unjoined.contains(ChannelView));
        assert!(!unjoined.contains(FilesView));
        assert!(!unjoined.contains(CalendarView));
        assert!(!unjoined.contains(MembersView));
        assert!(unjoined.contains(MessageSend));
        assert!(granted(&subject, &chain, joined()).contains(ChannelView));
        let allowed = channel(vec![rule(TargetRef::User, &[ChannelView], &[])]);
        assert!(granted(&subject, &allowed, Facts::default()).contains(ChannelView));
        let reserved = channel(vec![rule(TargetRef::BaseRole, &[], &[ChannelView])]);
        assert!(!granted(&subject, &reserved, joined()).contains(ChannelView));
    }

    #[test]
    fn no_rule_makes_a_guest_a_moderator() {
        let role = Uuid::new_v4();
        let mut subject = guest(&[]);
        subject.roles.push((role, PermissionSet::ALL));
        let chain = channel(vec![
            rule(TargetRef::Role(role), &Permission::ALL, &[]),
            rule(
                TargetRef::User,
                &[ChannelManage, MessageManage, ChannelMembersManage],
                &[],
            ),
        ]);
        let got = granted(&subject, &chain, joined());
        for never in [
            ChannelManage,
            MessageManage,
            ChannelMembersManage,
            SpaceSettings,
            MembersInvite,
            FilesManage,
        ] {
            assert!(!got.contains(never), "a guest got {}", never.name());
        }
        assert!(got.contains(ChannelView));
    }

    #[test]
    fn an_author_manages_their_file_and_a_guest_author_shares_no_public_link() {
        let file = vec![level(LevelKind::File, Vec::new())];
        let author = Facts {
            author: true,
            ..Facts::default()
        };
        let as_member = granted(&member(&[FilesView]), &file, author);
        assert!(as_member.contains(FilesManage));
        assert!(as_member.contains(FilesPublicLink));
        let as_guest = granted(&guest(&[]), &file, author);
        assert!(as_guest.contains(FilesManage));
        assert!(!as_guest.contains(FilesPublicLink));
        let not_author = granted(&member(&[FilesView]), &file, Facts::default());
        assert!(!not_author.contains(FilesManage));
        assert!(!not_author.contains(FilesPublicLink));
    }

    #[test]
    fn an_archived_channel_takes_writing_away_not_reactions() {
        let subject = member(&[
            ChannelView,
            MessageSend,
            MessageAttach,
            MessageReact,
            MessagePin,
        ]);
        let chain = channel(vec![rule(TargetRef::User, &[MessageSend], &[])]);
        let archived = Facts {
            archived: true,
            ..Facts::default()
        };
        let got = granted(&subject, &chain, archived);
        assert!(!got.contains(MessageSend));
        assert!(!got.contains(MessageAttach));
        assert!(got.contains(MessageReact));
        assert!(got.contains(ChannelView));
        // A property of the room, not a rule: its owner reads it like everybody else.
        let owner = Subject {
            standing: Standing::Owner,
            base: PermissionSet::EMPTY,
            roles: Vec::new(),
        };
        let theirs = granted(&owner, &chain, archived);
        assert!(!theirs.contains(MessageSend));
        assert!(!theirs.contains(MessageAttach));
        assert!(theirs.contains(ChannelManage));
    }

    #[test]
    fn explain_names_each_source() {
        let role = Uuid::new_v4();
        let mut subject = member(&[FilesView]);
        subject.roles.push((role, set(&[FilesEdit])));
        let folder = level(
            LevelKind::Folder,
            vec![rule(TargetRef::User, &[], &[FilesEdit])],
        );
        let folder_id = folder.id;
        let decision = resolve(&subject, &[folder], Facts::default(), true);
        assert!(!decision.granted.contains(FilesEdit));
        let grant = decision
            .trace
            .iter()
            .position(|step| {
                step.permission == FilesEdit
                    && step.effect == Effect::Granted
                    && step.source == Source::Role(role)
                    && step.level.is_none()
            })
            .expect("the role's grant is in the trace");
        let removal = decision
            .trace
            .iter()
            .position(|step| {
                step.permission == FilesEdit
                    && step.effect == Effect::Removed
                    && step.source == Source::User
                    && step.level == Some((LevelKind::Folder, folder_id))
            })
            .expect("the folder's deny is in the trace");
        assert!(
            grant < removal,
            "the trace keeps the order things happened in"
        );
    }

    #[test]
    fn no_trace_unless_asked() {
        let subject = member(&[ChannelView]);
        let chain = channel(vec![rule(TargetRef::BaseRole, &[], &[ChannelView])]);
        let decision = resolve(&subject, &chain, joined(), false);
        assert!(decision.trace.is_empty());
        assert!(!resolve(&subject, &chain, joined(), true).trace.is_empty());
    }

    #[test]
    fn a_group_and_a_role_rule_union_their_denies_first() {
        let role = Uuid::new_v4();
        let group = Uuid::new_v4();
        let mut subject = member(&[ChannelView, MessageSend]);
        subject.roles.push((role, PermissionSet::EMPTY));
        // One side allows, the other denies: the deny comes first whatever the side, so the allow
        // stands, as between two roles.
        let chain = channel(vec![
            rule(TargetRef::Role(role), &[MessageSend], &[]),
            rule(TargetRef::Group(group), &[], &[MessageSend]),
        ]);
        assert!(granted(&subject, &chain, Facts::default()).contains(MessageSend));
        // A group deny beats the base alone.
        let denied = channel(vec![rule(TargetRef::Group(group), &[], &[MessageSend])]);
        assert!(!granted(&subject, &denied, Facts::default()).contains(MessageSend));
        // A personal rule still comes after the group.
        let undone = channel(vec![
            rule(TargetRef::Group(group), &[], &[MessageSend]),
            rule(TargetRef::User, &[MessageSend], &[]),
        ]);
        assert!(granted(&subject, &undone, Facts::default()).contains(MessageSend));
    }

    #[test]
    fn an_audience_rule_adds_up_with_groups_and_names_its_source() {
        let audience = Uuid::new_v4();
        let subject = member(&[FilesView]);
        let file = vec![level(
            LevelKind::File,
            vec![rule(TargetRef::Audience(audience), &[FilesEdit], &[])],
        )];
        let decision = resolve(&subject, &file, Facts::default(), true);
        assert!(decision.granted.contains(FilesEdit));
        assert!(decision.trace.iter().any(|step| {
            step.permission == FilesEdit && step.source == Source::Audience(audience)
        }));
    }

    #[test]
    fn a_group_person_or_custom_role_allow_lifts_the_private_lock() {
        let group = Uuid::new_v4();
        let role = Uuid::new_v4();
        let mut subject = member(&[ChannelView]);
        subject.roles.push((role, PermissionSet::EMPTY));
        for lifting_rule in [
            lifting(TargetRef::Group(group), &[ChannelView], &[]),
            lifting(TargetRef::User, &[ChannelView], &[]),
            lifting(TargetRef::Role(role), &[ChannelView], &[]),
        ] {
            let chain = channel(vec![lifting_rule]);
            assert!(granted(&subject, &chain, private()).contains(ChannelView));
        }
        // The Administrator role, a base role, a channel role and an audience never do.
        for closed in [
            rule(TargetRef::Role(role), &[ChannelView], &[]),
            rule(TargetRef::BaseRole, &[ChannelView], &[]),
            rule(TargetRef::Audience(group), &[ChannelView], &[]),
        ] {
            let chain = channel(vec![closed]);
            assert!(!granted(&subject, &chain, private()).contains(ChannelView));
        }
    }

    #[test]
    fn a_deny_after_the_allow_keeps_the_lock() {
        let group = Uuid::new_v4();
        let subject = member(&[ChannelView]);
        // A personal deny comes after the group's allow.
        let chain = channel(vec![
            lifting(TargetRef::Group(group), &[ChannelView], &[]),
            rule(TargetRef::User, &[], &[ChannelView]),
        ]);
        assert!(!granted(&subject, &chain, private()).contains(ChannelView));
        // A deny of another group at the same level goes first and does not undo the allow.
        let other = Uuid::new_v4();
        let same = channel(vec![
            lifting(TargetRef::Group(group), &[ChannelView], &[]),
            rule(TargetRef::Group(other), &[], &[ChannelView]),
        ]);
        assert!(granted(&subject, &same, private()).contains(ChannelView));
        // A deny at a level below the channel (a conversation's file) undoes it.
        let below = vec![
            level(
                LevelKind::Channel,
                vec![lifting(TargetRef::Group(group), &[ChannelView], &[])],
            ),
            level(
                LevelKind::File,
                vec![rule(TargetRef::User, &[], &[ChannelView])],
            ),
        ];
        assert!(!granted(&subject, &below, private()).contains(ChannelView));
    }

    #[test]
    fn a_guest_stays_under_the_ceiling_through_every_target() {
        let group = Uuid::new_v4();
        let role = Uuid::new_v4();
        let audience = Uuid::new_v4();
        let mut subject = guest(&[ChannelView, MessageSend]);
        subject.roles.push((role, PermissionSet::EMPTY));
        for target in [
            TargetRef::Group(group),
            TargetRef::Role(role),
            TargetRef::User,
            TargetRef::Audience(audience),
        ] {
            for permission in Permission::ALL {
                let chain = channel(vec![lifting(target, &[permission], &[])]);
                for facts in [Facts::default(), private(), joined()] {
                    let got = granted(&subject, &chain, facts);
                    assert_eq!(
                        got.intersect(GUEST_CEILING),
                        PermissionSet::EMPTY,
                        "{target:?} gave a guest {}",
                        permission.name()
                    );
                }
            }
        }
    }

    /// The lock stays open only while nothing takes the view away: after a deny, a later rule that
    /// gives the view back with an allow that does not lift the lock must not reopen the room.
    #[test]
    fn a_later_non_lifting_allow_does_not_reopen_a_lock_a_deny_closed() {
        let group = Uuid::new_v4();
        let other = Uuid::new_v4();
        let subject = member(&[ChannelView]);
        let opening = || lifting(TargetRef::Group(group), &[ChannelView], &[]);
        let file_level = |rules: Vec<Rule>| level(LevelKind::File, rules);

        // The user pass: a personal deny, then the file level gives the view back.
        let by_user = vec![
            level(
                LevelKind::Channel,
                vec![opening(), rule(TargetRef::User, &[], &[ChannelView])],
            ),
            file_level(vec![rule(TargetRef::BaseRole, &[ChannelView], &[])]),
        ];
        assert!(!granted(&subject, &by_user, private()).contains(ChannelView));

        // The shared pass: a group deny on a lower level, then a personal allow there.
        let by_shared = vec![
            level(LevelKind::Channel, vec![opening()]),
            file_level(vec![
                rule(TargetRef::Group(other), &[], &[ChannelView]),
                rule(TargetRef::User, &[ChannelView], &[]),
            ]),
        ];
        assert!(!granted(&subject, &by_shared, private()).contains(ChannelView));

        // The base pass: a base deny on a lower level, then a group allow there.
        let by_base = vec![
            level(LevelKind::Channel, vec![opening()]),
            file_level(vec![
                rule(TargetRef::BaseRole, &[], &[ChannelView]),
                rule(TargetRef::Group(other), &[ChannelView], &[]),
            ]),
        ];
        assert!(!granted(&subject, &by_base, private()).contains(ChannelView));

        // Control: with no deny in between, the opening stands.
        let kept = vec![
            level(LevelKind::Channel, vec![opening()]),
            file_level(vec![rule(TargetRef::BaseRole, &[ChannelView], &[])]),
        ];
        assert!(granted(&subject, &kept, private()).contains(ChannelView));
    }

    #[test]
    fn a_guest_never_joined_is_opened_by_a_person_or_group_rule_only() {
        let group = Uuid::new_v4();
        let role = Uuid::new_v4();
        let mut subject = guest(&[]);
        subject.roles.push((role, PermissionSet::ALL));
        for opening in [
            lifting(TargetRef::User, &[ChannelView], &[]),
            lifting(TargetRef::Group(group), &[ChannelView], &[]),
        ] {
            let got = granted(&subject, &channel(vec![opening]), private());
            assert!(got.contains(ChannelView));
        }
        for closed in [
            rule(TargetRef::BaseRole, &[ChannelView], &[]),
            rule(TargetRef::Role(role), &[ChannelView], &[]),
        ] {
            let got = granted(&subject, &channel(vec![closed]), private());
            assert!(!got.contains(ChannelView));
        }
        // Opened by a rule, the guest still lacks everything above the ceiling.
        let everything = lifting(TargetRef::User, &Permission::ALL, &[]);
        let got = granted(&subject, &channel(vec![everything]), private());
        assert!(got.contains(ChannelView));
        assert_eq!(got.intersect(GUEST_CEILING), PermissionSet::EMPTY);
    }

    /// The line a lifted private lock leaves in the explanation, with who lifted it.
    fn lift_of(decision: &Decision) -> Option<Source> {
        decision
            .trace
            .iter()
            .find(|step| matches!(step.source, Source::Lifted(_)))
            .map(|step| step.source)
    }

    #[test]
    fn the_traced_lift_names_a_role_a_person_or_a_group() {
        let group = Uuid::new_v4();
        let role = Uuid::new_v4();
        let mut subject = member(&[ChannelView]);
        subject.roles.push((role, PermissionSet::EMPTY));
        for (rule, opener) in [
            (
                lifting(TargetRef::Group(group), &[ChannelView], &[]),
                Opener::Group(group),
            ),
            (lifting(TargetRef::User, &[ChannelView], &[]), Opener::User),
            (
                lifting(TargetRef::Role(role), &[ChannelView], &[]),
                Opener::Role(role),
            ),
        ] {
            let decision = resolve(&subject, &channel(vec![rule]), private(), true);
            assert!(decision.granted.contains(ChannelView));
            assert_eq!(lift_of(&decision), Some(Source::Lifted(opener)));
            assert!(!decision
                .trace
                .iter()
                .any(|step| step.source == Source::Implicit("private")));
        }
        // Not traced when nothing is locked: a joined member, a public channel.
        let rule = lifting(TargetRef::User, &[ChannelView], &[]);
        let decision = resolve(&subject, &channel(vec![rule.clone()]), joined(), true);
        assert_eq!(lift_of(&decision), None);
        assert_eq!(
            lift_of(&resolve(
                &subject,
                &channel(vec![rule]),
                Facts::default(),
                true
            )),
            None
        );
    }

    #[test]
    fn a_deny_after_a_lift_records_no_opener_and_the_channel_closes() {
        let group = Uuid::new_v4();
        let subject = member(&[ChannelView]);
        let chain = channel(vec![
            lifting(TargetRef::Group(group), &[ChannelView], &[]),
            rule(TargetRef::User, &[], &[ChannelView]),
        ]);
        let decision = resolve(&subject, &chain, private(), true);
        assert!(!decision.granted.contains(ChannelView));
        assert_eq!(lift_of(&decision), None);
        // The view was taken by the deny, so no lock line follows: nothing was left to lock.
        assert!(decision
            .trace
            .iter()
            .any(|step| step.source == Source::User && step.effect == Effect::Removed));
    }
}
