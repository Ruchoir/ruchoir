//! What an edition built on this crate may use from the core, and nothing else.
//!
//! Every other module of the crate is private: an edition reaches the server through
//! [`crate::edition::Edition`], the state it is handed ([`crate::state::AppState`]), the
//! configuration, the entities, and the items re-exported here. Adding something here widens what
//! another build depends on, so it is added when that build needs it and kept stable after.

/// `404` unless the caller administers the instance (the administration surface does not exist
/// for anyone else).
pub use crate::admin::ensure_instance_admin;
/// The space's audit log: [`record`] writes one entry ([`Action`] on a [`Target`]), inside the
/// caller's transaction when it has one. The only way anything writes to it.
pub use crate::audit::{record, Action, Target};
/// The signed-in caller, as an axum extractor (a `401` without a live session).
pub use crate::auth::extract::AuthSession;
/// Messages in Ruchoir's own layout: [`Notice`] is what the caller writes, [`notice`] draws it,
/// `AppState::mailer` sends the [`Email`]; [`Locale`] is a reader's language.
pub use crate::auth::mail_text::{notice, Email, Locale, Notice};
/// `403` unless the caller owns the space.
pub use crate::messaging::authz::ensure_space_owner;
/// The gate of every paid write: `402 licence_required`, `409 licence_frozen`, or through.
pub use crate::messaging::edition_view::ensure_paid;
/// The API's error responses (`403`, `404`, ...).
pub use crate::messaging::error::ApiError;
/// The permission catalogue (names, sets), what a guest can never hold, and what someone may do
/// space-wide.
pub use crate::permissions::catalogue::{Permission, PermissionSet};
/// Tell a space's members that what they may do there changed, so their apps ask again.
pub use crate::permissions::changed::announce;
pub use crate::permissions::check::space_rights;
/// The delegation rules every write of rights goes through: ranks, rule 1 ([`ensure_manages_role`]),
/// rule 2 ([`ensure_composes`]), rule 3 ([`ensure_acts_on`]).
pub use crate::permissions::delegation::{
    ensure_acts_on, ensure_composes, ensure_manages_role, fixed_role_position, rank_of, role, Rank,
    RoleRow,
};
/// A role as the API shows it ([`roles_of`] lists a space's for a viewer), the names and colours a
/// custom role may take.
/// Groups: one decision function for every act on one ([`decide`], with the refusal's mapping to
/// an HTTP error), the group as loaded, its DTO with what the caller may do, and the actor.
pub use crate::permissions::group_routes::{group_dto, group_dtos, GroupDto, GroupMay};
pub use crate::permissions::groups::{
    actor, decide, group, groups_of, GroupAct, GroupActor, GroupRow, Paid, Refusal,
};
/// The preset levels (Read, Contribute, Manage) and their rule sets, for the access dialogs.
pub use crate::permissions::levels::{
    clamp_for_guest, guest_may, level_of, level_sets, nearest_level, rule_sets, summary, Kind,
    Level, LevelError, LevelRead, Target as RuleTarget, TriState,
};
pub use crate::permissions::roles::{roles_of, validate_role_name, RoleDto, ROLE_COLOURS};
/// Who edits a resource's access and the one decision every rule write goes through, the writes
/// themselves (log entry included), and where a group or a role is still named by a rule.
pub use crate::permissions::rules::{
    current_rule, delete_rule, describe, editor_of, ensure_writable, level_name, lock_resource,
    uses_of, write_rule, Aim, Editor, EditorKind, Existing, Named, ResourceRef, RuleRefusal,
    RuleRow, RuleSubject, Shown, TargetRef, UsedIn,
};
pub use crate::permissions::system_roles::GUEST_CEILING;
