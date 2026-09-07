//! The messaging domain: the REST surface over the collaboration schema.
//!
//! Every mutation here is a typed, authorized HTTP handler; after it commits it hands the resulting
//! event to [`crate::realtime`] for fan-out. Reads and writes share one authorization choke point
//! ([`authz`]) and one DTO builder ([`messages::hydrate_messages`]).
//!
//! - [`authz`] - conversation membership guards and audience computation.
//! - [`dto`] - request and response shapes (close to the web data seam).
//! - [`error`] - the `ApiError` type and its HTTP mapping.
//! - [`mentions`] - `@`-mention parsing and resolution.
//! - [`slug`] - the one definition of a channel name / space slug handle.
//! - [`invitations`] - issuing, listing, revoking and accepting a space invitation.
//! - [`messages`] / [`reactions`] / [`read`] / [`pins`] / [`saved`] / [`conversations`] / [`channels`]
//!   / [`spaces`] - handlers.
//! - [`routes`] - the sub-router.

pub mod authz;
pub mod channels;
pub mod conversations;
pub mod dto;
pub mod error;
pub mod invitations;
pub mod mentions;
pub mod messages;
pub mod notifications;
pub mod pins;
pub mod reactions;
pub mod read;
pub mod routes;
pub mod saved;
pub mod search;
pub mod slug;
pub mod spaces;
pub mod users;
