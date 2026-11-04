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
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr, Statement,
};
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
    /// Its licence (for `seats`) expired at `expired_at`: what it configured keeps applying,
    /// nothing paid can be changed any more.
    Frozen {
        seats: u32,
        expired_at: OffsetDateTime,
    },
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

/// The seats a space uses: its owners and members. Guests take none, and neither does someone whose
/// membership is gone. What an edition's [`Edition::seat_check`] compares with the seats it sells,
/// and what the space's owners read as `used`.
pub async fn seats_used(
    db: &(impl ConnectionTrait + ?Sized),
    space_id: Uuid,
) -> Result<u32, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            // management: sees ended guests (guests hold no seat either way).
            "SELECT count(*)::bigint AS used FROM space_members \
             WHERE space_id = $1 AND standing IN ('owner', 'member')",
            [space_id.into()],
        ))
        .await?;
    let used: i64 = match row {
        Some(row) => row.try_get("", "used")?,
        None => 0,
    };
    Ok(u32::try_from(used).unwrap_or(u32::MAX))
}

/// Take the space's seat lock for the rest of the transaction: two writes that take a seat in the
/// same space (a promotion, an accepted link, an import of people) are served one after the other.
pub async fn lock_space_seats(txn: &DatabaseTransaction, space_id: Uuid) -> Result<(), DbErr> {
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [space_id.to_string().into()],
    ))
    .await?;
    Ok(())
}

/// The base an imported custom role is built on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BasedOn {
    Member,
    Admin,
}

/// A role of the source product that an import wants to bring over as a custom role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedRole {
    /// The role's identifier in the source product, stable across runs of the same import.
    pub source_id: String,
    pub name: String,
    pub based_on: BasedOn,
}

/// What an edition did with an [`ImportedRole`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportedRoleOutcome {
    /// A custom role was created, with this id.
    Created(Uuid),
    /// The import had created it already: this id.
    Existing(Uuid),
    /// This edition has no custom roles: the people take the base role instead.
    FallBack,
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

    /// Whether one more owner or member may be added to `space_id`. Counted on the transaction the
    /// caller holds the space's seat lock in, so asking never needs a second connection.
    async fn seat_check(
        &self,
        db: &DatabaseTransaction,
        space_id: Uuid,
    ) -> Result<SeatCheck, DbErr>;

    /// Routes this edition adds to the API, merged beside the core's. Absolute `/api/v1/...` paths,
    /// guarded per request like the core's own.
    fn routes(&self) -> Router<AppState>;

    /// Feature names this edition adds to `GET /api/v1/instance` (`compat::FEATURES`), under the
    /// same promise: a name once listed is never removed or reused.
    fn features(&self) -> &'static [&'static str];

    /// Start this edition's background jobs, once, when the server starts serving.
    fn background(&self, state: AppState);

    /// Bring a role of the source product over as a custom role of `space_id`, inside the
    /// import's transaction, on behalf of `actor`. Required, with no default, so that an edition
    /// cannot forget it: one without custom roles answers [`ImportedRoleOutcome::FallBack`].
    async fn import_custom_role(
        &self,
        txn: &DatabaseTransaction,
        space_id: Uuid,
        role: &ImportedRole,
        actor: Uuid,
    ) -> Result<ImportedRoleOutcome, DbErr>;
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
        _db: &DatabaseTransaction,
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

    async fn import_custom_role(
        &self,
        _txn: &DatabaseTransaction,
        _space_id: Uuid,
        _role: &ImportedRole,
        _actor: Uuid,
    ) -> Result<ImportedRoleOutcome, DbErr> {
        Ok(ImportedRoleOutcome::FallBack)
    }
}
