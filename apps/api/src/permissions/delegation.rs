//! Who may hand out what (design section 3): the four rules every write of rights goes through, in
//! the core and in any edition built on it.
//!
//! 1. **Managing a role** (editing, granting, removing it) needs `roles.manage` and a role placed
//!    strictly below the actor's highest one ([`ensure_manages_role`]).
//! 2. **You only compose what you hold**: a permission is put in or taken out of a role, or a rule,
//!    only by someone who holds it ([`ensure_composes`]). Handing out a role placed below one's own
//!    is rule 1's business, whatever the role holds (Théo, 2026-11-03: Discord's rule).
//! 3. **Acting on a person** (their roles, their removal, their standing) needs their highest role
//!    strictly below the actor's ([`ensure_acts_on`]); nobody outranks themselves.
//! 4. **Only an owner makes an owner**, and the last owner stays (where ownership moves).
//!
//! A person's rank is the position of their highest role (Administrator 100, custom roles where
//! they were placed, `@members` 0, `@guests` -1); an owner stands above every position, never above
//! another owner.

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::Resource;
use crate::messaging::error::ApiError;

/// Where someone stands for delegation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rank {
    Owner,
    Position(i32),
}

impl Rank {
    /// Whether this rank is strictly above a role placed at `position`.
    pub fn outranks_position(self, position: i32) -> bool {
        match self {
            Rank::Owner => true,
            Rank::Position(mine) => mine > position,
        }
    }

    /// Whether this rank is strictly above `other`'s (an owner is not above another owner).
    pub fn outranks(self, other: Rank) -> bool {
        match other {
            Rank::Owner => false,
            Rank::Position(theirs) => self.outranks_position(theirs),
        }
    }
}

/// A role as delegation reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleRow {
    pub id: Uuid,
    /// `administrator`, `members` or `guests` for a system role.
    pub system_key: Option<String>,
    pub name: String,
    pub colour: Option<String>,
    pub position: i32,
    pub permissions: PermissionSet,
}

/// `user_id`'s rank in `space_id`, or `None` when they are not in it.
pub async fn rank_of(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<Rank>, DbErr> {
    let Some(row) = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT m.standing, \
                    greatest( \
                        (SELECT max(r.position) FROM space_role_assignments a \
                           JOIN space_roles r ON r.id = a.role_id \
                          WHERE a.space_id = m.space_id AND a.user_id = m.user_id), \
                        (SELECT r.position FROM space_roles r WHERE r.space_id = m.space_id \
                            AND r.system_key = CASE WHEN m.standing = 'guest' THEN 'guests' \
                                                    ELSE 'members' END), \
                        CASE WHEN m.standing = 'guest' THEN -1 ELSE 0 END \
                    ) AS position \
               FROM space_members m WHERE m.space_id = $1 AND m.user_id = $2",
            [space_id.into(), user_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let standing: String = row.try_get("", "standing")?;
    if standing == "owner" {
        return Ok(Some(Rank::Owner));
    }
    Ok(Some(Rank::Position(row.try_get("", "position")?)))
}

/// The position a fixed role sits at in this space (the legacy names `admin`, `member`, `guest`),
/// for the ladder that still speaks them; `owner` stands above every position.
pub async fn fixed_role_position(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    role: &str,
) -> Result<Option<i32>, DbErr> {
    let key = match role {
        "admin" => "administrator",
        "member" => "members",
        "guest" => "guests",
        _ => return Ok(None),
    };
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT position FROM space_roles WHERE space_id = $1 AND system_key = $2",
            [space_id.into(), key.into()],
        ))
        .await?;
    match row {
        Some(row) => Ok(Some(row.try_get("", "position")?)),
        None => Ok(None),
    }
}

/// A role of `space_id`, or `None` (including when the id names another space's role).
pub async fn role(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    role_id: Uuid,
) -> Result<Option<RoleRow>, DbErr> {
    let Some(row) = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, system_key, name::text AS name, colour, position, permissions \
               FROM space_roles WHERE id = $1 AND space_id = $2",
            [role_id.into(), space_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(RoleRow {
        id: row.try_get("", "id")?,
        system_key: row.try_get("", "system_key")?,
        name: row.try_get("", "name")?,
        colour: row.try_get("", "colour")?,
        position: row.try_get("", "position")?,
        permissions: PermissionSet::from_names(&row.try_get::<Vec<String>>("", "permissions")?),
    }))
}

/// Rule 1: `actor` may manage `role_id` (holds `roles.manage` here, and the role sits strictly
/// below their rank). Answers the role. `404` for a role this space does not have.
pub async fn ensure_manages_role(
    db: &sea_orm::DatabaseConnection,
    space_id: Uuid,
    actor: Uuid,
    role_id: Uuid,
) -> Result<RoleRow, ApiError> {
    crate::messaging::authz::ensure_permission(
        db,
        space_id,
        actor,
        Resource::Space,
        Permission::RolesManage,
    )
    .await?;
    let role = role(db, space_id, role_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rank = rank_of(db, space_id, actor)
        .await?
        .ok_or(ApiError::Forbidden)?;
    if !rank.outranks_position(role.position) {
        return Err(ApiError::ForbiddenBecause("role_above_you"));
    }
    Ok(role)
}

/// Rule 2: every permission `after` adds to `before` or takes out of it is one the actor holds.
/// Permissions the actor lacks may stay as they are.
pub fn ensure_composes(
    actor_rights: PermissionSet,
    before: PermissionSet,
    after: PermissionSet,
) -> Result<(), ApiError> {
    let changed = after.minus(before).union(before.minus(after));
    if changed.minus(actor_rights).is_empty() {
        Ok(())
    } else {
        Err(ApiError::ForbiddenBecause("permission_not_held"))
    }
}

/// Rule 3: `actor` may act on `target` (both in the space, the target strictly below the actor).
pub async fn ensure_acts_on(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Uuid,
    target: Uuid,
) -> Result<(), ApiError> {
    let actor_rank = rank_of(db, space_id, actor)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let target_rank = rank_of(db, space_id, target)
        .await?
        .ok_or(ApiError::NotFound)?;
    if actor == target || !actor_rank.outranks(target_rank) {
        return Err(ApiError::ForbiddenBecause("person_above_you"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owner_outranks_every_position_but_not_an_owner() {
        assert!(Rank::Owner.outranks_position(i32::MAX - 1));
        assert!(Rank::Owner.outranks(Rank::Position(100)));
        assert!(!Rank::Owner.outranks(Rank::Owner));
        assert!(!Rank::Position(100).outranks(Rank::Owner));
    }

    #[test]
    fn a_rank_outranks_only_strictly_lower_positions() {
        assert!(Rank::Position(100).outranks_position(99));
        assert!(!Rank::Position(100).outranks_position(100));
        assert!(!Rank::Position(0).outranks_position(50));
        assert!(Rank::Position(0).outranks(Rank::Position(-1)));
        assert!(!Rank::Position(0).outranks(Rank::Position(0)));
    }

    #[test]
    fn composing_needs_every_changed_permission() {
        let actor = PermissionSet::of(&[Permission::MembersInvite, Permission::ChannelsCreate]);
        let before = PermissionSet::of(&[Permission::MessageManage, Permission::ChannelsCreate]);
        // Adding one held, keeping one not held: fine.
        let after = before.union(PermissionSet::of(&[Permission::MembersInvite]));
        assert!(ensure_composes(actor, before, after).is_ok());
        // Removing one held: fine.
        let after = before.minus(PermissionSet::of(&[Permission::ChannelsCreate]));
        assert!(ensure_composes(actor, before, after).is_ok());
        // Adding one not held: refused.
        let after = before.union(PermissionSet::of(&[Permission::FilesManage]));
        assert!(ensure_composes(actor, before, after).is_err());
        // Removing one not held: refused.
        let after = before.minus(PermissionSet::of(&[Permission::MessageManage]));
        assert!(ensure_composes(actor, before, after).is_err());
        // Nothing changed: fine whatever the actor holds.
        assert!(ensure_composes(PermissionSet::EMPTY, before, before).is_ok());
    }
}
