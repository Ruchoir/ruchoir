//! How a space's edition reads in its DTO (`edition` for every member, `licence` for its owners),
//! and the seat check every way of adding an owner or a member goes through.

use sea_orm::DatabaseConnection;
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
/// one, and nobody is ever taken out for it.
pub async fn ensure_a_seat(state: &AppState, space_id: Uuid) -> Result<(), ApiError> {
    match state.edition.seat_check(&state.db, space_id).await? {
        SeatCheck::Allowed => Ok(()),
        SeatCheck::Full { seats } => Err(ApiError::SeatsFull {
            seats,
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
