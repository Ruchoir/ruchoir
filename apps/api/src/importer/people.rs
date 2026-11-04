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
use super::run::{Mapper, Result, RunError, KIND_GROUP, KIND_ROLE, KIND_USER};
use crate::edition::{lock_space_seats, Edition, ImportedRole, ImportedRoleOutcome, SeatCheck};
use crate::entities::{space_groups, space_members, spaces};
use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, QueryFilter, Statement};

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
    importer: Uuid,
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

        // Who this run put in the space, with the custom roles the archive gives them.
        let mut holders: Vec<(Uuid, &[String])> = Vec::new();
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
                    // A guest ignores roles (P8), and somebody who was in the space already is
                    // never given one.
                    if role != "guest" {
                        if let Some(line) = index
                            .members
                            .iter()
                            .find(|m| &m.space == source_space && m.user == user)
                        {
                            if !line.roles.is_empty() {
                                holders.push((user_id, &line.roles));
                            }
                        }
                    }
                }
                Admitted::Present => written.kept.push(name_of(user)),
            }
        }
        import_roles(
            db,
            mapper,
            index,
            (source_space, *space_id),
            &holders,
            edition,
            importer,
            &mut written,
        )
        .await?;
    }
    Ok(written)
}

/// The custom roles of a space, for the people this run put in it.
///
/// A role nobody this run admitted holds is not created. Each is asked of the edition inside one
/// transaction with the assignments, so a role is never created and left unassigned. An edition
/// without custom roles answers `FallBack`: the holders keep the fixed role the role is based on,
/// raised to administrator for an administrator-based one (P9), and the summary says so.
#[allow(clippy::too_many_arguments)]
async fn import_roles(
    db: &DatabaseConnection,
    mapper: &Mapper<'_>,
    index: &Index,
    space: (&str, Uuid),
    holders: &[(Uuid, &[String])],
    edition: &dyn Edition,
    importer: Uuid,
    written: &mut PeopleWritten,
) -> Result<()> {
    let (source_space, space_id) = space;
    for role in index.roles.iter().filter(|r| r.space == source_space) {
        let holding: Vec<Uuid> = holders
            .iter()
            .filter(|(_, roles)| roles.contains(&role.id))
            .map(|(user, _)| *user)
            .collect();
        if holding.is_empty() {
            continue;
        }
        let txn = db.begin().await?;
        let known = mapper
            .resolve(&txn, KIND_ROLE, &role.id, Some(space_id))
            .await?;
        let outcome = match known {
            Some(id) => ImportedRoleOutcome::Existing(id),
            None => {
                let wanted = ImportedRole {
                    source_id: role.id.clone(),
                    name: role.name.clone(),
                    based_on: if role.based_on == "admin" {
                        crate::edition::BasedOn::Admin
                    } else {
                        crate::edition::BasedOn::Member
                    },
                };
                edition
                    .import_custom_role(&txn, space_id, &wanted, importer)
                    .await?
            }
        };
        match outcome {
            ImportedRoleOutcome::Created(id) | ImportedRoleOutcome::Existing(id) => {
                if known.is_none() {
                    mapper
                        .record(&txn, KIND_ROLE, &role.id, Some(space_id), id)
                        .await?;
                }
                for user in &holding {
                    txn.execute_raw(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "INSERT INTO space_role_assignments (space_id, user_id, role_id) \
                         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                        [space_id.into(), (*user).into(), id.into()],
                    ))
                    .await?;
                }
                written.custom_roles += 1;
            }
            ImportedRoleOutcome::FallBack => {
                let fixed = if role.based_on == "admin" {
                    "admin"
                } else {
                    "member"
                };
                if fixed == "admin" {
                    for user in &holding {
                        // Only somebody this run admitted, and only up from member.
                        let raised = txn
                            .execute_raw(Statement::from_sql_and_values(
                                DbBackend::Postgres,
                                "UPDATE space_members SET role = 'admin' \
                                 WHERE space_id = $1 AND user_id = $2 AND role = 'member'",
                                [space_id.into(), (*user).into()],
                            ))
                            .await?
                            .rows_affected();
                        written.administrators += raised as usize;
                    }
                }
                match written
                    .fallbacks
                    .iter_mut()
                    .find(|f| f.role == role.name && f.fixed == fixed)
                {
                    Some(found) => found.people += holding.len(),
                    None => written.fallbacks.push(Fallback {
                        role: role.name.clone(),
                        fixed: fixed.to_owned(),
                        people: holding.len(),
                    }),
                }
            }
        }
        txn.commit().await?;
    }
    Ok(())
}

/// The groups of the archive, with their members and no rights.
///
/// A group is found by its archive id (so a re-run fills it and a group renamed here keeps its new
/// name), else created. A name already taken in the space by a group this import did not make
/// becomes `Name (Source)`, then `Name (Source) 2`, and so on. Members who have no account here
/// (skipped) are left out; members of the space are everyone the people pass admitted.
pub async fn import_groups(
    db: &DatabaseConnection,
    mapper: &Mapper<'_>,
    index: &Index,
    spaces_by_source: &[(String, Uuid)],
    importer: Uuid,
    source: &str,
) -> Result<PeopleWritten> {
    let imported_from = format!("{source}:{}", mapper.job_id);
    let mut written = PeopleWritten::default();
    for group in &index.groups {
        let Some((_, space_id)) = spaces_by_source.iter().find(|(id, _)| id == &group.space) else {
            continue;
        };
        let space_id = *space_id;
        let txn = db.begin().await?;
        let group_id = match mapper
            .resolve(&txn, KIND_GROUP, &group.id, Some(space_id))
            .await?
        {
            Some(id) => {
                written.groups_filled += 1;
                id
            }
            None => {
                let name = free_group_name(&txn, space_id, &group.name, source).await?;
                let id = Uuid::new_v4();
                let now = OffsetDateTime::now_utc();
                let description: String = group.description.chars().take(280).collect();
                space_groups::ActiveModel {
                    id: Set(id),
                    space_id: Set(space_id),
                    name: Set(name),
                    description: Set((!description.trim().is_empty()).then_some(description)),
                    source: Set("manual".to_owned()),
                    external_id: Set(None),
                    created_by: Set(Some(importer)),
                    imported_from: Set(Some(imported_from.clone())),
                    created_at: Set(now),
                    updated_at: Set(now),
                }
                .insert(&txn)
                .await?;
                mapper
                    .record(&txn, KIND_GROUP, &group.id, Some(space_id), id)
                    .await?;
                written.groups += 1;
                id
            }
        };
        for person in &group.members {
            let Some(user_id) = mapper.resolve(&txn, KIND_USER, person, None).await? else {
                continue;
            };
            // The foreign key wants the person in the space: they are, unless the pass that
            // admits people left them out, and then there is nothing to add.
            txn.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO space_group_members (group_id, space_id, user_id, is_manager, added_by) \
                 SELECT $1, $2, $3, false, $4 \
                 WHERE EXISTS (SELECT 1 FROM space_members WHERE space_id = $2 AND user_id = $3) \
                 ON CONFLICT DO NOTHING",
                [group_id.into(), space_id.into(), user_id.into(), importer.into()],
            ))
            .await?;
        }
        txn.commit().await?;
    }
    Ok(written)
}

/// The first of `Name`, `Name (Source)`, `Name (Source) 2`, ... that no group of the space has.
async fn free_group_name<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    wanted: &str,
    source: &str,
) -> Result<String> {
    let base: String = wanted.trim().chars().take(100).collect();
    let mut shown = source.to_owned();
    if let Some(first) = shown.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    let mut candidate = base.clone();
    let mut attempt = 0;
    loop {
        let taken = space_groups::Entity::find()
            .filter(space_groups::Column::SpaceId.eq(space_id))
            .filter(sea_orm::sea_query::Expr::cust_with_values(
                "lower(name::text) = lower($1)",
                [candidate.clone()],
            ))
            .one(db)
            .await?
            .is_some();
        if !taken {
            return Ok(candidate);
        }
        attempt += 1;
        let suffix = if attempt == 1 {
            format!(" ({shown})")
        } else {
            format!(" ({shown}) {attempt}")
        };
        let room = 100usize.saturating_sub(suffix.chars().count());
        candidate = format!("{}{suffix}", base.chars().take(room).collect::<String>());
    }
}
