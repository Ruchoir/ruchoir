//! The edition this server runs as.
//!
//! The community build (this repository, AGPL) runs [`CommunityEdition`]: every space is
//! `Community`, there is no seat limit, and nothing is added to the API. Another build may hand
//! [`crate::run`] its own implementation; this trait is the only door it comes in through, and
//! everything it may use from the core is re-exported by [`crate::ext`]. This repository never
//! names, fetches or requires such a build.
//!
//! What an edition decides is narrow on purpose: whether a space is entitled to more than the
//! community features (and until when), whether a member may still be added to it, and which routes,
//! feature names and background jobs it brings. The permission engine itself is the core's and
//! evaluates whatever is stored, whatever the edition: a community build started on a database a
//! licensed build wrote keeps applying every rule it finds there.

use axum::Router;
use sea_orm::{DatabaseConnection, DbErr};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::state::AppState;

/// What a space is entitled to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entitlement {
    /// The community features: everything this repository ships.
    Community,
    /// Paid features are on for this space, for `seats` owners and members, until `valid_until`.
    Enterprise {
        seats: u32,
        valid_until: OffsetDateTime,
    },
    /// Its licence expired at `expired_at`: what it configured keeps applying, nothing paid can be
    /// changed any more.
    Frozen { expired_at: OffsetDateTime },
}

/// Whether one more owner or member may join a space. Guests never take a seat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatCheck {
    Allowed,
    /// Every one of the `seats` is taken.
    Full {
        seats: u32,
    },
}

/// A build of the server: the community one, or one made elsewhere on top of this crate.
#[async_trait::async_trait]
pub trait Edition: Send + Sync + 'static {
    /// A short name, for the logs.
    fn name(&self) -> &'static str;

    /// What `space_id` is entitled to now.
    async fn entitlement(
        &self,
        db: &DatabaseConnection,
        space_id: Uuid,
    ) -> Result<Entitlement, DbErr>;

    /// Whether one more owner or member may be added to `space_id`.
    async fn seat_check(&self, db: &DatabaseConnection, space_id: Uuid)
        -> Result<SeatCheck, DbErr>;

    /// Routes this edition adds to the API, merged beside the core's. Absolute `/api/v1/...` paths,
    /// guarded per request like the core's own.
    fn routes(&self) -> Router<AppState>;

    /// Feature names this edition adds to `GET /api/v1/instance` (`compat::FEATURES`), under the
    /// same promise: a name once listed is never removed or reused.
    fn features(&self) -> &'static [&'static str];

    /// Start this edition's background jobs, once, when the server starts serving.
    fn background(&self, state: AppState);
}

/// The community build: every space is `Community`, nobody is ever refused a seat.
#[derive(Debug, Clone, Copy, Default)]
pub struct CommunityEdition;

#[async_trait::async_trait]
impl Edition for CommunityEdition {
    fn name(&self) -> &'static str {
        "community"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, DbErr> {
        Ok(Entitlement::Community)
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> Router<AppState> {
        Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}
