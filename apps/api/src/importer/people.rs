//! The people of an archive, put in their spaces with the standing it gives them (permissions
//! lot 6).
//!
//! Before this pass, a person reached a space only by being in one of its conversations, and always
//! as a member. Format 2 lists who stands where, so an administrator arrives an administrator and a
//! guest a guest, also when they sit in no channel at all.
//!
//! Three rules hold it together:
//!
//! - **Nobody who is already in a space is touched.** A row there (an ended guest included) means
//!   `Present`: its role stays, up or down, and nothing is inserted. An import adds people; it
//!   never edits one.
//! - **Nobody becomes an owner.** The format has no such value; the importer owns the spaces it
//!   creates and that row is never rewritten.
//! - **A seat is counted where it is taken.** Each admission takes the space's seat lock and asks
//!   the edition on the same transaction, so a space that filled since the plan stops the run with
//!   the same refusal the plan would have given, whoever is racing it.

use std::collections::HashSet;

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, EntityTrait, TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use super::archive::Index;
use super::run::{Mapper, Result, RunError, KIND_USER};
use crate::edition::{lock_space_seats, Edition, SeatCheck};
use crate::entities::{space_members, spaces};

/// What `admit` found or did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admitted {
    /// A row was written.
    Added,
    /// The person was in the space already: nothing was changed.
    Present,
    /// The row is one this very import wrote on an earlier pass (a run that stopped and resumed):
    /// nothing was changed, and it still counts as the import's work.
    Earlier,
}

/// A role of the source that this edition could not create, and what the people holding it got.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fallback {
    pub role: String,
    pub fixed: String,
    pub people: usize,
}

/// A licensed space's seats once the run is over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeatsUsed {
    pub space: String,
    pub used: u32,
    pub total: u32,
}

/// What this run did with people.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeopleWritten {
    pub added: usize,
    pub administrators: usize,
    pub guests: usize,
    /// Names of the people who were in their space already and were left as they were.
    pub kept: Vec<String>,
    pub moderators: usize,
    pub groups: usize,
    pub groups_filled: usize,
    pub custom_roles: usize,
    pub fallbacks: Vec<Fallback>,
    pub seats: Vec<SeatsUsed>,
}

/// Put one person in a space, once, within the seats.
///
/// One short transaction. A guest takes no seat, so asks nothing; anyone else is checked by the
/// edition under the space's seat lock, on this transaction, before the row is written.
pub async fn admit(
    db: &DatabaseConnection,
    edition: &dyn Edition,
    space_id: Uuid,
    user_id: Uuid,
    role: &str,
    imported_from: &str,
) -> Result<Admitted> {
    let txn = db.begin().await?;
    lock_space_seats(&txn, space_id).await?;
    // management: sees ended guests (a row there, ended or not, blocks the insert).
    if let Some(row) = space_members::Entity::find_by_id((space_id, user_id))
        .one(&txn)
        .await?
    {
        txn.commit().await?;
        return Ok(if row.imported_from.as_deref() == Some(imported_from) {
            Admitted::Earlier
        } else {
            Admitted::Present
        });
    }
    if role != "guest" {
        if let SeatCheck::Full { seats } = edition.seat_check(&txn, space_id).await? {
            let space = spaces::Entity::find_by_id(space_id)
                .one(&txn)
                .await?
                .map(|space| space.name)
                .unwrap_or_default();
            return Err(RunError::SeatsFull { space, seats });
        }
    }
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(user_id),
        role: Set(role.to_owned()),
        invited_by: Set(None),
        joined_at: Set(OffsetDateTime::now_utc()),
        imported_from: Set(Some(imported_from.to_owned())),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;
    Ok(Admitted::Added)
}

/// The role a person holds in a space, `None` when they are not in it.
pub async fn standing_of(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>> {
    // management: sees ended guests (the role is what is asked, not whether access is live).
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|row| row.role))
}

/// Admit everyone the archive puts in a space: the lines of `members.jsonl` with the role they
/// give, then whoever sits in one of the space's conversations or groups without a line, as a
/// member. Skipped people (no account) are left out.
pub async fn import_people(
    db: &DatabaseConnection,
    mapper: &Mapper<'_>,
    index: &Index,
    spaces_by_source: &[(String, Uuid)],
    edition: &dyn Edition,
    source: &str,
) -> Result<PeopleWritten> {
    let imported_from = format!("{source}:{}", mapper.job_id);
    let mut written = PeopleWritten::default();
    let name_of = |id: &str| {
        index
            .users
            .iter()
            .find(|user| user.id == id)
            .map_or_else(|| id.to_owned(), |user| user.display_name.clone())
    };

    for (source_space, space_id) in spaces_by_source {
        let mut listed: HashSet<&str> = HashSet::new();
        let mut order: Vec<(&str, &str)> = Vec::new();
        for line in index.members.iter().filter(|m| &m.space == source_space) {
            if listed.insert(line.user.as_str()) {
                order.push((line.user.as_str(), line.role.as_str()));
            }
        }
        // Whoever sits in a conversation or a group of the space without a line is a member.
        let others = index
            .channels
            .iter()
            .filter(|c| &c.space == source_space)
            .flat_map(|c| c.members.iter())
            .chain(
                index
                    .groups
                    .iter()
                    .filter(|g| &g.space == source_space)
                    .flat_map(|g| g.members.iter()),
            );
        for user in others {
            if listed.insert(user.as_str()) {
                order.push((user.as_str(), "member"));
            }
        }

        for (user, role) in order {
            let Some(user_id) = mapper.resolve(db, KIND_USER, user, None).await? else {
                continue;
            };
            // Never an owner: the format has no such value, and a stray one is a member.
            let role = match role {
                "admin" | "guest" => role,
                _ => "member",
            };
            match admit(db, edition, *space_id, user_id, role, &imported_from).await? {
                Admitted::Added | Admitted::Earlier => {
                    written.added += 1;
                    match role {
                        "admin" => written.administrators += 1,
                        "guest" => written.guests += 1,
                        _ => {}
                    }
                }
                Admitted::Present => written.kept.push(name_of(user)),
            }
        }
    }
    Ok(written)
}
