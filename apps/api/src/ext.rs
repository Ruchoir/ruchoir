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
/// The API's error responses (`403`, `404`, ...).
pub use crate::messaging::error::ApiError;
/// Tell a space's members that what they may do there changed, so their apps ask again.
pub use crate::permissions::changed::announce;
/// The delegation rules every write of rights goes through: ranks, rule 1 ([`ensure_manages_role`]),
/// rule 2 ([`ensure_composes`]), rule 3 ([`ensure_acts_on`]).
pub use crate::permissions::delegation::{
    ensure_acts_on, ensure_composes, ensure_manages_role, fixed_role_position, rank_of, role, Rank,
    RoleRow,
};
