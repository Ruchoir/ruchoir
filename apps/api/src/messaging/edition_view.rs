//! How a space's edition reads in its DTO (`edition` for every member, `licence` for its owners),
//! and the seat check every way of adding an owner or a member goes through.

use sea_orm::{DatabaseConnection, DatabaseTransaction, TransactionTrait};
use time::OffsetDateTime;
use uuid::Uuid;

use super::dto::{rfc3339, SpaceLicenceDto};
use super::error::ApiError;
use crate::edition::{seats_used, Edition, Entitlement, SeatCheck};
use crate::permissions::engine::Standing;
use crate::state::AppState;

/// `edition` and, for an owner of a licensed (or frozen) space, `licence`, for `user_id` in
/// `space_id`.
pub async fn describe(
    db: &DatabaseConnection,
    edition: &dyn Edition,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(String, Option<SpaceLicenceDto>), ApiError> {
    let entitlement = edition.entitlement(db, space_id).await?;
    let (name, licence) = match entitlement {
        Entitlement::Community => return Ok(("community".to_owned(), None)),
        Entitlement::Enterprise { seats, valid_until } => {
            ("enterprise", Some((seats, valid_until)))
        }
        // An expired licence still shows its seats: the next one is bought from them.
        Entitlement::Frozen { seats, expired_at } => ("frozen", Some((seats, expired_at))),
    };
    let owner =
        crate::permissions::check::standing(db, space_id, user_id).await? == Some(Standing::Owner);
    let licence = match (owner, licence) {
        (true, Some((seats, valid_until))) => Some(SpaceLicenceDto {
            seats,
            used: seats_used(db, space_id).await?,
            valid_until: rfc3339(valid_until),
            expires_in_days: days_left(valid_until, OffsetDateTime::now_utc()),
        }),
        _ => None,
    };
    Ok((name.to_owned(), licence))
}

/// `402 seats_full` when `space_id` has no seat left for one more owner or member. Asked before
/// anyone takes a seat: a member invitation issued or accepted, a guest made a member. Guests take
/// none, so they never ask; removing someone never asks either. Two arrivals at the same instant
/// may both find the last seat: the space then reads one over its seats, which refuses the next
/// one, and nobody is ever taken out for it. A write that takes the seat asks
/// [`ensure_a_seat_locked`] instead, which closes that window.
pub async fn ensure_a_seat(state: &AppState, space_id: Uuid) -> Result<(), ApiError> {
    let txn = state.db.begin().await?;
    seat_gate(state, &txn, space_id).await
}

async fn seat_gate(
    state: &AppState,
    db: &DatabaseTransaction,
    space_id: Uuid,
) -> Result<(), ApiError> {
    match state.edition.seat_check(db, space_id).await? {
        SeatCheck::Allowed => Ok(()),
        SeatCheck::Full { seats } => Err(ApiError::SeatsFull {
            seats,
            pricing_url: state.config.pricing_url.clone(),
        }),
    }
}

/// [`ensure_a_seat`] as the last step before a write that takes the seat, inside its transaction:
/// the space's seat lock is held until the commit, so two arrivals for the last seat are taken one
/// after the other and the second finds it gone. Every way of taking a seat after the space exists
/// (a guest made a member, a member link accepted) goes through here.
pub async fn ensure_a_seat_locked(
    txn: &DatabaseTransaction,
    state: &AppState,
    space_id: Uuid,
) -> Result<(), ApiError> {
    crate::edition::lock_space_seats(txn, space_id).await?;
    // Counted on the transaction's own connection: a waiter on the lock never needs a second one,
    // so a burst of promotions cannot starve the pool of the one holding the lock.
    seat_gate(state, txn, space_id).await
}

/// The gate of every paid write (custom roles, their order, the base roles' rights, fine rules):
/// `402 licence_required` in a space without a licence, `409 licence_frozen` in one whose licence
/// expired, nothing in a licensed one. Reads are never gated: what a space configured keeps showing
/// and applying whatever happens to its licence.
pub async fn ensure_paid(state: &AppState, space_id: Uuid) -> Result<(), ApiError> {
    match state.edition.entitlement(&state.db, space_id).await? {
        Entitlement::Enterprise { .. } => Ok(()),
        Entitlement::Frozen { .. } => Err(ApiError::LicenceFrozen),
        Entitlement::Community => Err(ApiError::LicenceRequired {
            pricing_url: state.config.pricing_url.clone(),
        }),
    }
}

/// Whether someone joining with today's `role` takes a seat: everyone but a guest.
pub fn takes_a_seat(role: &str) -> bool {
    role != "guest"
}

/// Whole days from `now` to `until`, rounded up; 0 once `until` has passed.
fn days_left(until: OffsetDateTime, now: OffsetDateTime) -> i64 {
    let seconds = (until - now).whole_seconds();
    if seconds <= 0 {
        0
    } else {
        (seconds + 86_399) / 86_400
    }
}

#[cfg(test)]
mod tests {
    use super::days_left;
    use time::macros::datetime;

    #[test]
    fn days_left_round_up_and_stop_at_zero() {
        let end = datetime!(2027-12-31 0:00 UTC);
        assert_eq!(days_left(end, datetime!(2027-12-30 0:00 UTC)), 1);
        assert_eq!(days_left(end, datetime!(2027-12-30 12:00 UTC)), 1);
        assert_eq!(days_left(end, datetime!(2027-12-24 0:00 UTC)), 7);
        assert_eq!(days_left(end, datetime!(2027-12-23 23:00 UTC)), 8);
        assert_eq!(days_left(end, end), 0);
        assert_eq!(days_left(end, datetime!(2028-01-02 0:00 UTC)), 0);
    }
}
