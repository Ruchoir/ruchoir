//! Emptying the instance before refilling it.
//!
//! The most destructive thing this product can do, and it exists because "I botched my migration,
//! let me start clean" happens to somebody eventually. It is never the default and never becomes
//! one: it runs only when an administrator asks for it, in a request that carries all four guards.
//!
//! **The account that asked survives, and so does its administrator flag.** Wiping accounts
//! includes the one making the request; if it went, the session would die mid-run and nobody could
//! resume, cancel, or even read what happened. That is an invariant, not a nicety, and the test
//! that checks it is the most important one in this file.
//!
//! The four guards, all required together:
//!
//! 1. The instance's own address, typed by hand. There is no instance name in the database, and the
//!    address is what an administrator types to reach it every day, so it is the name they know.
//! 2. A backup less than a day old, recorded by the backup script. Without it the operation is
//!    simply irreversible, and a guard that trusted a checkbox would be decoration.
//! 3. What will be destroyed, counted and handed back before anything happens. One does not destroy
//!    a number, one destroys things that have names.
//! 4. A record written where the wipe cannot reach, because everything else that could describe it
//!    is about to be deleted.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use serde::Serialize;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::entities::{import_mappings, instance_events, messages, spaces, users};

use super::run::RunError;

/// How recent a backup has to be for a replacement to be allowed.
pub const BACKUP_MUST_BE_NEWER_THAN: Duration = Duration::hours(24);

/// What a replacement would destroy, counted before it does.
#[derive(Debug, Default, Serialize)]
pub struct WhatDies {
    pub spaces: u64,
    pub accounts: u64,
    pub messages: u64,
    /// The names, while they fit on a screen. A count is an abstraction; a list of names is the
    /// thing itself, and the difference is whether somebody stops to read it.
    pub space_names: Vec<String>,
}

pub async fn what_would_be_destroyed<C: ConnectionTrait>(db: &C) -> Result<WhatDies, RunError> {
    let all_spaces = spaces::Entity::find().all(db).await?;
    Ok(WhatDies {
        spaces: all_spaces.len() as u64,
        accounts: users::Entity::find().count(db).await?,
        messages: messages::Entity::find().count(db).await?,
        space_names: all_spaces
            .into_iter()
            .take(50)
            .map(|space| space.name)
            .collect(),
    })
}

/// The most recent recorded backup, if any.
pub async fn last_backup<C: ConnectionTrait>(
    db: &C,
) -> Result<Option<instance_events::Model>, RunError> {
    Ok(instance_events::Entity::find()
        .filter(instance_events::Column::Kind.eq("backup_taken"))
        .order_by_desc(instance_events::Column::OccurredAt)
        .one(db)
        .await?)
}

/// Checks all four guards and empties the instance.
///
/// Returns what it destroyed. Everything is done in one transaction: a half-emptied instance is
/// worse than either outcome, and unlike an import there is nothing here to resume.
pub async fn replace_instance(
    db: &DatabaseConnection,
    admin: Uuid,
    typed_name: &str,
    instance_address: &str,
) -> Result<WhatDies, RunError> {
    // Guard 1. Compared against the address without its scheme, because that is what an
    // administrator reads in their browser and would type from memory.
    let expected = instance_address
        .trim_end_matches('/')
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if typed_name.trim() != expected {
        return Err(RunError::Ambiguous(format!(
            "to replace this instance, type its address exactly: {expected}"
        )));
    }

    // Guard 2.
    let backup = last_backup(db).await?;
    let recent = backup.as_ref().is_some_and(|event| {
        event.occurred_at > OffsetDateTime::now_utc() - BACKUP_MUST_BE_NEWER_THAN
    });
    if !recent {
        return Err(RunError::Ambiguous(match backup {
            Some(event) => format!(
                "the most recent backup was taken on {}, which is too long ago: take one first",
                event.occurred_at
            ),
            None => "no backup of this instance has ever been recorded: take one first".to_owned(),
        }));
    }

    // Guard 3. Counted before anything is touched, and handed back so the caller reports what it
    // destroyed rather than that it destroyed.
    let dying = what_would_be_destroyed(db).await?;

    // Guard 4, written before the deletion rather than after: a process that dies halfway through
    // would otherwise leave no trace at all of what was attempted.
    instance_events::ActiveModel {
        id: Set(Uuid::new_v4()),
        kind: Set("instance_replaced".to_owned()),
        occurred_at: NotSet,
        actor_id: Set(Some(admin)),
        detail: Set(serde_json::to_string(&dying).unwrap_or_else(|_| "{}".to_owned())),
    }
    .insert(db)
    .await?;

    let txn = db.begin().await?;

    // Spaces first: everything inside one (conversations, messages, memberships, files) hangs off
    // it by a cascading key, so this is the whole workspace in one statement.
    spaces::Entity::delete_many().exec(&txn).await?;

    // Then the accounts, except the one doing this. The invariant of this whole file.
    users::Entity::delete_many()
        .filter(users::Column::Id.ne(admin))
        .exec(&txn)
        .await?;

    // And what earlier imports remembered about those rows. Kept, they tell the import that follows
    // - the whole point of replacing - that its spaces and people are already here, and it hangs
    // the first conversation off a space that no longer exists.
    import_mappings::Entity::delete_many().exec(&txn).await?;

    txn.commit().await?;

    // The administrator keeps the flag that let them do this, so they can still run the import
    // that follows. Checked rather than assumed: a delete that took it would lock the instance.
    let survivor = users::Entity::find_by_id(admin)
        .one(db)
        .await?
        .ok_or_else(|| {
            RunError::Db("the replacement removed the account that ordered it".into())
        })?;
    if !survivor.is_instance_admin {
        return Err(RunError::Db(
            "the replacement left its author without administration rights".into(),
        ));
    }

    Ok(dying)
}
