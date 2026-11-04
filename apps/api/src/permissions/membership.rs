//! Who is in a space: the one definition of an active membership.
//!
//! A guest whose end date has passed is no longer in the space, everywhere at once, but their row
//! stays (for ninety days, so they can be reactivated). Every question of the form "is this person
//! in this space" goes through here, and the database answers exactly at `expires_at`: the test is
//! `expires_at > now()` in SQL, never a clock read by the application. Management screens, which
//! must also see people whose access ended, use [`any`] and [`ended`].

use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use uuid::Uuid;

use crate::entities::space_members;

/// The text of [`ACTIVE_SQL`] for a `space_members` row under another alias: `active_sql!("a")`.
macro_rules! active_sql {
    () => {
        $crate::permissions::membership::active_sql!("m")
    };
    ($alias:literal) => {
        concat!(
            "(",
            $alias,
            ".expires_at IS NULL OR ",
            $alias,
            ".expires_at > now())"
        )
    };
}
pub(crate) use active_sql;

/// SQL for "this `space_members` row (aliased `m`) is an active membership", for the raw queries
/// that cannot use [`active_condition`].
pub const ACTIVE_SQL: &str = active_sql!();

/// [`ACTIVE_SQL`] for the query builder.
pub fn active_condition() -> Condition {
    Condition::any()
        .add(space_members::Column::ExpiresAt.is_null())
        .add(Expr::col(space_members::Column::ExpiresAt).gt(Expr::cust("now()")))
}

/// A membership row and whether its access has ended (as of the database's clock).
#[derive(Clone, Debug)]
#[allow(dead_code)] // used by the ended-access screens (task 5)
pub struct Membership {
    pub model: space_members::Model,
    pub ended: bool,
}

#[derive(FromQueryResult)]
#[allow(dead_code)] // used by `any` (task 5)
struct WithEnded {
    #[sea_orm(nested)]
    model: space_members::Model,
    ended: bool,
}

/// `user_id`'s active membership of the space; `None` when they never were in it or their access
/// ended.
pub async fn active<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<space_members::Model>, DbErr> {
    space_members::Entity::find_by_id((space_id, user_id))
        .filter(active_condition())
        .one(db)
        .await
}

/// Everyone active in the space.
pub async fn active_ids<C: ConnectionTrait>(db: &C, space_id: Uuid) -> Result<Vec<Uuid>, DbErr> {
    space_members::Entity::find()
        .select_only()
        .column(space_members::Column::UserId)
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(active_condition())
        .order_by_asc(space_members::Column::UserId)
        .into_tuple()
        .all(db)
        .await
}

/// Every active membership row of `user_id`, whole.
pub async fn active_of_user<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<Vec<space_members::Model>, DbErr> {
    space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(user_id))
        .filter(active_condition())
        .order_by_asc(space_members::Column::SpaceId)
        .all(db)
        .await
}

/// The active memberships of the space held by `user_ids`, whole.
pub async fn active_among<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_ids: Vec<Uuid>,
) -> Result<Vec<space_members::Model>, DbErr> {
    space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(space_members::Column::UserId.is_in(user_ids))
        .filter(active_condition())
        .all(db)
        .await
}

/// How many people are active in the space.
pub async fn count_active<C: ConnectionTrait>(db: &C, space_id: Uuid) -> Result<i64, DbErr> {
    Ok(space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(active_condition())
        .count(db)
        .await? as i64)
}

/// The people actively in any of `space_ids` (once each), among `only` when given.
pub async fn active_users_in<C: ConnectionTrait>(
    db: &C,
    space_ids: Vec<Uuid>,
    only: Option<Vec<Uuid>>,
) -> Result<Vec<Uuid>, DbErr> {
    let mut query = space_members::Entity::find()
        .select_only()
        .column(space_members::Column::UserId)
        .distinct()
        .filter(space_members::Column::SpaceId.is_in(space_ids))
        .filter(active_condition());
    if let Some(only) = only {
        query = query.filter(space_members::Column::UserId.is_in(only));
    }
    query
        .order_by_asc(space_members::Column::UserId)
        .into_tuple()
        .all(db)
        .await
}

/// The spaces `user_id` is actively in.
pub async fn spaces_of<C: ConnectionTrait>(db: &C, user_id: Uuid) -> Result<Vec<Uuid>, DbErr> {
    space_members::Entity::find()
        .select_only()
        .column(space_members::Column::SpaceId)
        .filter(space_members::Column::UserId.eq(user_id))
        .filter(active_condition())
        .order_by_asc(space_members::Column::SpaceId)
        .into_tuple()
        .all(db)
        .await
}

/// The guests of the space whose access has ended and whose row is still there, oldest end first.
#[allow(dead_code)] // used by the ended-access screens (task 5)
pub async fn ended<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
) -> Result<Vec<space_members::Model>, DbErr> {
    space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(space_members::Column::ExpiresAt.is_not_null())
        .filter(active_condition().not())
        .order_by_asc(space_members::Column::ExpiresAt)
        .all(db)
        .await
}

/// The row of `user_id` in the space, ended or not. For management only (reactivating, removing);
/// everything else asks [`active`].
#[allow(dead_code)] // used by the ended-access screens (task 5)
pub async fn any<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<Membership>, DbErr> {
    let ended = Expr::col(space_members::Column::ExpiresAt)
        .is_not_null()
        .and(Expr::col(space_members::Column::ExpiresAt).lte(Expr::cust("now()")));
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .column_as(ended, "ended")
        .into_model::<WithEnded>()
        .one(db)
        .await?
        .map(|row| Membership {
            model: row.model,
            ended: row.ended,
        }))
}
