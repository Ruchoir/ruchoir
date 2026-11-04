//! Preset levels: the one table every access dialog reads and writes.
//!
//! A level (Read, Contribute, Manage, or None for "everyone") stands for an exact set of
//! permissions on a channel, a file or folder, or a calendar. [`rule_sets`] turns a level into the
//! allow and deny sets a rule stores; [`level_of`] reads a stored rule back, and says
//! [`LevelRead::Custom`] when it matches no level. Pure: no I/O, so every dialog, route and
//! screen agrees by construction.

#![allow(dead_code)] // Read by the rule routes (permissions lot 4, task 4).

use super::catalogue::{Family, Permission, PermissionSet};
use super::system_roles::GUEST_CEILING;

/// What a rule is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Channel,
    File,
    Calendar,
}

/// A preset level, from the lowest to the highest (`None` only exists for "everyone").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Level {
    None,
    Read,
    Contribute,
    Manage,
}

/// Who a rule is written for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Everyone,
    Role { system: bool },
    Group,
    User,
    Audience,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LevelError {
    /// "No access" is a deny for one target: it is free for "everyone" only.
    NoneNeedsFineRules,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LevelRead {
    Level(Level),
    /// Nothing stored that the legacy writes do not own: there is no rule to show.
    NoRule,
    Custom,
}

/// How a rule treats one permission, for the "Personnalise" summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriState {
    /// The rule allows it although the nearest level does not.
    Allow,
    /// The rule denies it.
    Deny,
    /// The nearest level grants it and the rule does not.
    Unset,
}

const LEVELS: [Level; 3] = [Level::Read, Level::Contribute, Level::Manage];

fn view_of(kind: Kind) -> Permission {
    match kind {
        Kind::Channel => Permission::ChannelView,
        Kind::File => Permission::FilesView,
        Kind::Calendar => Permission::CalendarView,
    }
}

fn family_of(kind: Kind) -> Family {
    match kind {
        Kind::Channel => Family::Channel,
        Kind::File => Family::Files,
        Kind::Calendar => Family::Calendar,
    }
}

/// The permissions of a level. `None` is the empty set.
pub fn level_sets(kind: Kind, level: Level) -> PermissionSet {
    use Permission as P;
    let (read, contribute, manage): (&[P], &[P], &[P]) = match kind {
        Kind::Channel => (
            &[P::ChannelView, P::MessageReact],
            &[
                P::MessageSend,
                P::MessageAttach,
                P::MessagePin,
                P::MessageMentionAll,
            ],
            &[P::MessageManage, P::ChannelMembersManage, P::ChannelManage],
        ),
        Kind::File => (
            &[P::FilesView],
            &[P::FilesCreate, P::FilesEdit],
            &[P::FilesManage, P::FilesPublicLink],
        ),
        Kind::Calendar => (
            &[P::CalendarView],
            &[P::CalendarWrite],
            &[P::CalendarManage],
        ),
    };
    let mut set = PermissionSet::EMPTY;
    let upto = match level {
        Level::None => 0,
        Level::Read => 1,
        Level::Contribute => 2,
        Level::Manage => 3,
    };
    for part in [read, contribute, manage].iter().take(upto) {
        set = set.union(PermissionSet::of(part));
    }
    set
}

/// The allow and deny sets a rule stores for a level.
pub fn rule_sets(
    kind: Kind,
    target: Target,
    level: Level,
) -> Result<(PermissionSet, PermissionSet), LevelError> {
    if level == Level::None {
        return if target == Target::Everyone {
            Ok((PermissionSet::EMPTY, PermissionSet::of(&[view_of(kind)])))
        } else {
            Err(LevelError::NoneNeedsFineRules)
        };
    }
    let sets = level_sets(kind, level);
    let deny = if target == Target::Everyone {
        level_sets(kind, Level::Manage).minus(sets)
    } else {
        PermissionSet::EMPTY
    };
    Ok((sets, deny))
}

/// The bit the legacy writes own on a system role (spec pre-flight P2).
fn legacy_bit(kind: Kind) -> Option<Permission> {
    match kind {
        Kind::Channel => Some(Permission::ChannelView),
        Kind::File => None,
        Kind::Calendar => Some(Permission::CalendarWrite),
    }
}

/// Reads a stored rule as a level: the exact inverse of [`rule_sets`]. A read never shows more or
/// less than what is stored and applied:
///
/// - a denied view on everyone is "no access", whatever else the rule holds;
/// - for everyone and the Administrator, the bit the legacy writes own (spec pre-flight P2) is set
///   aside to match a level, and read for what it does when the rest is empty or ambiguous
///   (a calendar's write bit: denied is Read, allowed is Contribute); a rule holding nothing else
///   is [`LevelRead::NoRule`];
/// - an ambiguous or unmatched rule is custom.
pub fn level_of(
    kind: Kind,
    target: Target,
    allow: PermissionSet,
    deny: PermissionSet,
) -> LevelRead {
    let candidates = [Level::None, Level::Read, Level::Contribute, Level::Manage];
    let everyone = target == Target::Everyone;
    if everyone && deny.contains(view_of(kind)) {
        return LevelRead::Level(Level::None);
    }
    let exact: Vec<Level> = candidates
        .into_iter()
        .filter(|&l| rule_sets(kind, target, l) == Ok((allow, deny)))
        .collect();
    if let [level] = exact[..] {
        return LevelRead::Level(level);
    }
    let admin = target == (Target::Role { system: true });
    let Some(bit) = legacy_bit(kind).filter(|_| everyone || admin) else {
        return LevelRead::Custom;
    };
    if admin && deny.contains(bit) {
        // The legacy writes never deny the Administrator.
        return LevelRead::Custom;
    }
    let mask = |s: PermissionSet| s.minus(PermissionSet::of(&[bit]));
    // What the legacy bit says on its own, for everyone's calendar write.
    let by_bit = || match (kind, allow.contains(bit), deny.contains(bit)) {
        (Kind::Calendar, false, true) if everyone => LevelRead::Level(Level::Read),
        (Kind::Calendar, true, false) if everyone => LevelRead::Level(Level::Contribute),
        _ => LevelRead::Custom,
    };
    if mask(allow).is_empty() && mask(deny).is_empty() {
        let legacy = allow.contains(bit) || deny.contains(bit);
        return if kind == Kind::Calendar && everyone && legacy {
            by_bit()
        } else {
            LevelRead::NoRule
        };
    }
    let masked: Vec<Level> = candidates
        .into_iter()
        .filter(|&l| {
            rule_sets(kind, target, l)
                .is_ok_and(|(a, d)| (mask(a), mask(d)) == (mask(allow), mask(deny)))
        })
        .collect();
    match masked[..] {
        [level] => LevelRead::Level(level),
        [_, _, ..] => by_bit(),
        [] => LevelRead::Custom,
    }
}

/// Whether a guest may hold the level: nothing in it may sit above the guest ceiling.
pub fn guest_may(kind: Kind, level: Level) -> bool {
    level_sets(kind, level).intersect(GUEST_CEILING).is_empty()
}

/// The highest level at or below `level` that a guest may hold.
pub fn clamp_for_guest(kind: Kind, level: Level) -> Level {
    [Level::Manage, Level::Contribute, Level::Read, Level::None]
        .into_iter()
        .find(|&l| l <= level && guest_may(kind, l))
        .unwrap_or(Level::None)
}

/// The level whose permissions differ least from `allow` (the lower one on a tie).
pub fn nearest_level(kind: Kind, allow: PermissionSet) -> Level {
    let distance = |l: Level| {
        let s = level_sets(kind, l);
        s.minus(allow).iter().count() + allow.minus(s).iter().count()
    };
    [Level::None, Level::Read, Level::Contribute, Level::Manage]
        .into_iter()
        .min_by_key(|&l| distance(l))
        .unwrap_or(Level::None)
}

/// How a custom rule differs from its nearest level, one entry per permission of the kind's family.
pub fn summary(
    kind: Kind,
    allow: PermissionSet,
    deny: PermissionSet,
) -> Vec<(Permission, TriState)> {
    let near = level_sets(kind, nearest_level(kind, allow));
    Permission::ALL
        .into_iter()
        .filter(|p| p.family() == family_of(kind))
        .filter_map(|p| {
            if deny.contains(p) {
                Some((p, TriState::Deny))
            } else if allow.contains(p) && !near.contains(p) {
                Some((p, TriState::Allow))
            } else if !allow.contains(p) && near.contains(p) {
                Some((p, TriState::Unset))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use Permission as P;

    const KINDS: [Kind; 3] = [Kind::Channel, Kind::File, Kind::Calendar];
    const TARGETS: [Target; 6] = [
        Target::Everyone,
        Target::Role { system: true },
        Target::Role { system: false },
        Target::Group,
        Target::User,
        Target::Audience,
    ];

    fn names(set: PermissionSet) -> Vec<&'static str> {
        set.iter().map(|p| p.name()).collect()
    }

    fn same(set: PermissionSet, expected: &[&str]) {
        let want = PermissionSet::of(
            &expected
                .iter()
                .map(|n| Permission::parse(n).unwrap())
                .collect::<Vec<_>>(),
        );
        assert_eq!(set, want, "got {:?}", names(set));
    }

    #[test]
    fn level_sets_are_the_pinned_tables() {
        same(level_sets(Kind::Channel, Level::None), &[]);
        same(
            level_sets(Kind::Channel, Level::Read),
            &["channel.view", "message.react"],
        );
        same(
            level_sets(Kind::Channel, Level::Contribute),
            &[
                "channel.view",
                "message.react",
                "message.send",
                "message.attach",
                "message.pin",
                "message.mention_all",
            ],
        );
        same(
            level_sets(Kind::Channel, Level::Manage),
            &[
                "channel.view",
                "message.react",
                "message.send",
                "message.attach",
                "message.pin",
                "message.mention_all",
                "message.manage",
                "channel.members.manage",
                "channel.manage",
            ],
        );
        same(level_sets(Kind::File, Level::Read), &["files.view"]);
        same(
            level_sets(Kind::File, Level::Contribute),
            &["files.view", "files.create", "files.edit"],
        );
        same(
            level_sets(Kind::File, Level::Manage),
            &[
                "files.view",
                "files.create",
                "files.edit",
                "files.manage",
                "files.public_link",
            ],
        );
        same(level_sets(Kind::Calendar, Level::Read), &["calendar.view"]);
        same(
            level_sets(Kind::Calendar, Level::Contribute),
            &["calendar.view", "calendar.write"],
        );
        same(
            level_sets(Kind::Calendar, Level::Manage),
            &["calendar.view", "calendar.write", "calendar.manage"],
        );
    }

    #[test]
    fn each_level_contains_the_one_below() {
        for kind in KINDS {
            let [r, c, m] = LEVELS.map(|l| level_sets(kind, l));
            assert_eq!(r.intersect(c), r);
            assert_eq!(c.intersect(m), c);
            assert_ne!(r, c);
            assert_ne!(c, m);
        }
    }

    #[test]
    fn rule_sets_round_trip_through_level_of() {
        for kind in KINDS {
            for target in TARGETS {
                for level in [Level::None, Level::Read, Level::Contribute, Level::Manage] {
                    if let Ok((allow, deny)) = rule_sets(kind, target, level) {
                        assert_eq!(
                            level_of(kind, target, allow, deny),
                            LevelRead::Level(level),
                            "{kind:?} {target:?} {level:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn none_is_free_for_everyone_only() {
        let (allow, deny) = rule_sets(Kind::Channel, Target::Everyone, Level::None).unwrap();
        assert!(allow.is_empty());
        same(deny, &["channel.view"]);
        for target in TARGETS.into_iter().filter(|t| *t != Target::Everyone) {
            assert_eq!(
                rule_sets(Kind::File, target, Level::None),
                Err(LevelError::NoneNeedsFineRules)
            );
        }
    }

    #[test]
    fn a_level_for_everyone_denies_the_higher_permissions() {
        let (allow, deny) = rule_sets(Kind::Channel, Target::Everyone, Level::Read).unwrap();
        assert_eq!(allow, level_sets(Kind::Channel, Level::Read));
        same(
            deny,
            &[
                "message.send",
                "message.attach",
                "message.pin",
                "message.mention_all",
                "message.manage",
                "channel.members.manage",
                "channel.manage",
            ],
        );
        let (_, deny) = rule_sets(Kind::Channel, Target::Everyone, Level::Manage).unwrap();
        assert!(deny.is_empty());
        let (allow, deny) = rule_sets(Kind::Channel, Target::Group, Level::Read).unwrap();
        assert_eq!(allow, level_sets(Kind::Channel, Level::Read));
        assert!(deny.is_empty());
    }

    #[test]
    fn a_rule_with_one_permission_less_reads_custom() {
        for kind in KINDS {
            for target in [Target::Everyone, Target::Group, Target::User] {
                let (allow, deny) = rule_sets(kind, target, Level::Manage).unwrap();
                let mut less = allow;
                // Not the legacy-owned bit, which a system role's read ignores on purpose.
                let dropped = if kind == Kind::Channel {
                    P::MessageReact
                } else {
                    view_of(kind)
                };
                less.remove(dropped);
                assert_eq!(level_of(kind, target, less, deny), LevelRead::Custom);
            }
        }
        let (mut allow, deny) = rule_sets(Kind::Channel, Target::Group, Level::Contribute).unwrap();
        allow.remove(P::MessagePin);
        assert_eq!(
            level_of(Kind::Channel, Target::Group, allow, deny),
            LevelRead::Custom
        );
        let sum = summary(Kind::Channel, allow, deny);
        assert_eq!(sum, vec![(P::MessagePin, TriState::Unset)]);
    }

    #[test]
    fn legacy_bits_are_masked_for_system_roles() {
        let set = |ps: &[Permission]| PermissionSet::of(ps);
        let none = PermissionSet::EMPTY;
        let admin = Target::Role { system: true };
        // The reservation-derived deny of channel.view on everyone is "no access".
        assert_eq!(
            level_of(
                Kind::Channel,
                Target::Everyone,
                none,
                set(&[P::ChannelView])
            ),
            LevelRead::Level(Level::None)
        );
        // The derived Administrator allow of channel.view is no entry at all.
        assert_eq!(
            level_of(Kind::Channel, admin, set(&[P::ChannelView]), none),
            LevelRead::NoRule
        );
        // A deny of the view bit on a system role other than everyone is not a legacy write.
        assert_eq!(
            level_of(Kind::Channel, admin, none, set(&[P::ChannelView])),
            LevelRead::Custom
        );
        // The write bit of a calendar: members read only, or write.
        assert_eq!(
            level_of(
                Kind::Calendar,
                Target::Everyone,
                none,
                set(&[P::CalendarWrite])
            ),
            LevelRead::Level(Level::Read)
        );
        assert_eq!(
            level_of(
                Kind::Calendar,
                Target::Everyone,
                set(&[P::CalendarWrite]),
                none
            ),
            LevelRead::Level(Level::Contribute)
        );
        assert_eq!(
            level_of(
                Kind::Calendar,
                Target::Everyone,
                set(&[P::CalendarView]),
                set(&[P::CalendarWrite, P::CalendarManage])
            ),
            LevelRead::Level(Level::Read)
        );
        // Nothing stored is no rule, not "no access".
        assert_eq!(
            level_of(Kind::Channel, Target::Everyone, none, none),
            LevelRead::NoRule
        );
        assert_eq!(
            level_of(Kind::Calendar, Target::Everyone, none, none),
            LevelRead::NoRule
        );
        // A group's rule is not masked.
        assert_eq!(
            level_of(Kind::Channel, Target::Group, set(&[P::ChannelView]), none),
            LevelRead::Custom
        );
    }

    #[test]
    fn a_denied_view_reads_no_access_whatever_else_is_stored() {
        for kind in KINDS {
            let view = view_of(kind);
            let all = level_sets(kind, Level::Manage);
            assert_eq!(
                level_of(
                    kind,
                    Target::Everyone,
                    PermissionSet::EMPTY,
                    PermissionSet::of(&[view])
                ),
                LevelRead::Level(Level::None)
            );
            assert_eq!(
                level_of(
                    kind,
                    Target::Everyone,
                    all.minus(PermissionSet::of(&[view])),
                    all
                ),
                LevelRead::Level(Level::None)
            );
        }
        let react = PermissionSet::of(&[P::MessageReact]);
        let deny = level_sets(Kind::Channel, Level::Manage).minus(react);
        assert!(deny.contains(P::ChannelView));
        assert_eq!(
            level_of(Kind::Channel, Target::Everyone, react, deny),
            LevelRead::Level(Level::None)
        );
    }

    #[test]
    fn a_guest_never_reads_manage() {
        for kind in KINDS {
            assert!(!guest_may(kind, Level::Manage));
            assert!(guest_may(kind, Level::Read));
            assert!(guest_may(kind, Level::None));
            assert_eq!(clamp_for_guest(kind, Level::Manage), Level::Contribute);
            assert_eq!(clamp_for_guest(kind, Level::Read), Level::Read);
            assert!(GUEST_CEILING
                .intersect(level_sets(kind, clamp_for_guest(kind, Level::Manage)))
                .is_empty());
        }
    }

    #[test]
    fn the_catalogue_names_all_exist() {
        for kind in KINDS {
            for level in LEVELS {
                for p in level_sets(kind, level).iter() {
                    assert_eq!(Permission::parse(p.name()), Some(p));
                    assert!(
                        p.resource_level(),
                        "{} is not settable on a resource",
                        p.name()
                    );
                    assert_eq!(p.family(), family_of(kind));
                }
            }
        }
    }
}
