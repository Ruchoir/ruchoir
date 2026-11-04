//! The guests' end dates, kept by one periodic sweep.
//!
//! A guest may be given a date after which they are no longer in the space. Three things follow
//! from it, in this order of a guest's life:
//!
//! - **Reminders**, seven days and one day before. The people who may manage the guest (hold
//!   `members.manage`, ranked above them) get a notice in the app each time; the one who invited
//!   them is the only one mailed when they are still able to manage them, otherwise every manager
//!   is. The guest gets a notice of their own the day before. Which reminders a guest has had is
//!   `space_members.expiry_stage` (`NULL`, `7`, `1`, then `0` once the end was announced), written
//!   by the same statement that picks who is reminded, so two sweeps at once never both win.
//! - **The end**: at the date, [`membership`] already says the person is gone everywhere, because
//!   it reads the database's clock. The sweep records it (`member.expired`) and announces
//!   `permissions.changed` to the space and to the guest, once, so open screens catch up.
//! - **The purge**, ninety days after: the row, and with it the channel, group and role rows
//!   hanging from it, is removed (`member.purged`). What they wrote stays.
//!
//! A guest whose date is moved later must start over: [`restart`] clears the stage.

use std::collections::BTreeSet;
use std::time::Duration as StdDuration;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter,
    Set, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use super::catalogue::Permission;
use super::check;
use super::{changed, delegation};
use crate::audit::{self, Action, Target};
use crate::auth::mail_text::{self, GuestExpiryWords, Locale};
use crate::calendar::events::FALLBACK_TIME_ZONE;
use crate::calendar::print_text::long_date;
use crate::calendar::recurrence;
use crate::calendar::reminders::reader_time_zone;
use crate::entities::{channel_members, channels, notifications, space_members, spaces, users};
use crate::messaging::dto::{rfc3339, NotificationDto};
use crate::notify::prefs;
use crate::state::AppState;

/// Days an ended guest stays listed, reactivable, before their row is removed.
pub const KEEP_DAYS: i64 = 90;

/// A notice to the people who manage a guest.
pub const KIND_SOON: &str = "guest_expiry_soon";

/// A notice to a guest that their access ends tomorrow.
pub const KIND_ENDING: &str = "guest_access_ending";

/// Whether `kind` is one of the two guest notices.
pub fn is_guest_notice(kind: &str) -> bool {
    kind == KIND_SOON || kind == KIND_ENDING
}

/// What a guest notice carries.
#[derive(Debug, Serialize, Deserialize)]
struct Payload {
    space_id: Uuid,
    user_id: Uuid,
    ends_at: String,
    days: i32,
}

/// What one sweep did.
#[derive(Debug, Default)]
pub struct Report {
    /// Guests who were reminded.
    pub reminded: u32,
    /// The people a reminder mail was decided for, and the language it is written in.
    pub mailed: Vec<(Uuid, Locale)>,
    /// `(space, guest)` for every access that was closed.
    pub expired: Vec<(Uuid, Uuid)>,
    /// Ended guests whose row was removed.
    pub purged: u32,
}

/// Start the sweep, every `RUCHOIR_GUEST_EXPIRY_SWEEP_SECS` seconds (a minute by default).
pub fn spawn(state: AppState) {
    let every = state.config.guest_expiry_sweep_secs;
    if every == 0 {
        tracing::info!("RUCHOIR_GUEST_EXPIRY_SWEEP_SECS is 0: guests' end dates are not swept");
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(StdDuration::from_secs(every));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match sweep(&state, OffsetDateTime::now_utc()).await {
                Ok(report)
                    if report.reminded == 0 && report.expired.is_empty() && report.purged == 0 => {}
                Ok(report) => tracing::info!(
                    reminded = report.reminded,
                    expired = report.expired.len(),
                    purged = report.purged,
                    "swept guests' end dates"
                ),
                Err(error) => tracing::warn!(?error, "guest expiry sweep failed"),
            }
        }
    });
}

/// Run one sweep as of `now`: reminders, then closings, then the purge.
pub async fn sweep(state: &AppState, now: OffsetDateTime) -> Result<Report, DbErr> {
    sweep_in(state, now, None).await
}

/// [`sweep`] limited to one space (`None`: every space). The periodic job sweeps everything; a
/// test, running beside others on one database, sweeps its own space.
pub async fn sweep_in(
    state: &AppState,
    now: OffsetDateTime,
    space: Option<Uuid>,
) -> Result<Report, DbErr> {
    let mut report = Report::default();
    remind(state, now, space, &mut report).await?;
    expire(state, now, space, &mut report).await?;
    purge(state, now, space, &mut report).await?;
    Ok(report)
}

/// The end date as `locale` writes it, read in `zone` (the reader's): 23:30 UTC the 19th is the
/// 20th in Paris. An unknown zone reads in the instance's fallback.
pub fn end_text(locale: Locale, ends: OffsetDateTime, zone: &str) -> String {
    let date = recurrence::local_parts(ends, zone)
        .or_else(|| recurrence::local_parts(ends, FALLBACK_TIME_ZONE))
        .map_or_else(|| ends.date(), |(date, _, _)| date);
    long_date(locale, date, false, true)
}

/// Start a guest's reminders over, after their date moved: the next threshold they are within is
/// reminded again. Part of the same transaction as the move.
pub async fn restart<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE space_members SET expiry_stage = NULL, expiry_notice_sent_at = NULL \
         WHERE space_id = $1 AND user_id = $2",
        [space_id.into(), user_id.into()],
    ))
    .await?;
    Ok(())
}

/// The threshold a guest ending at `expires_at` is within, as SQL: `1` inside the last day, `7`
/// inside the last week, otherwise nothing.
const TARGET: &str = "CASE WHEN expires_at <= $1::timestamptz + interval '1 day' THEN 1 ELSE 7 END";

/// One guest picked for a threshold.
struct Due {
    space_id: Uuid,
    user_id: Uuid,
    invited_by: Option<Uuid>,
    expires_at: OffsetDateTime,
    days: i32,
    /// False when the guest joined after the threshold was crossed: their stage moves on, and
    /// nobody is bothered about a date they were invited with.
    announce: bool,
}

async fn remind(
    state: &AppState,
    now: OffsetDateTime,
    space: Option<Uuid>,
    report: &mut Report,
) -> Result<(), DbErr> {
    let txn = state.db.begin().await?;
    // The stage is moved and read back by one statement: whoever's statement moves it wins the
    // right to send, and a second sweep waiting on the same row finds it already moved.
    let rows = txn
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "WITH picked AS ( \
                    SELECT space_id, user_id FROM space_members \
                     WHERE standing = 'guest' AND expires_at IS NOT NULL \
                       AND expires_at > $1::timestamptz \
                       AND expires_at <= $1::timestamptz + interval '7 days' \
                       AND ($2::uuid IS NULL OR space_id = $2) \
                       AND (expiry_stage IS NULL OR expiry_stage > {TARGET}) \
                     ORDER BY space_id, user_id FOR UPDATE) \
                 UPDATE space_members m SET \
                    expiry_stage = {TARGET}, \
                    expiry_notice_sent_at = CASE \
                        WHEN joined_at <= expires_at - ({TARGET}) * interval '1 day' \
                        THEN $1::timestamptz ELSE expiry_notice_sent_at END \
                   FROM picked p WHERE m.space_id = p.space_id AND m.user_id = p.user_id \
                 RETURNING m.space_id, m.user_id, m.invited_by, m.expires_at, m.expiry_stage, \
                    (m.joined_at <= m.expires_at - m.expiry_stage * interval '1 day') AS announce"
            ),
            [now.into(), space.into()],
        ))
        .await?;
    let mut due = Vec::new();
    for row in rows {
        due.push(Due {
            space_id: row.try_get("", "space_id")?,
            user_id: row.try_get("", "user_id")?,
            invited_by: row.try_get("", "invited_by")?,
            expires_at: row.try_get("", "expires_at")?,
            days: i32::from(row.try_get::<i16>("", "expiry_stage")?),
            announce: row.try_get("", "announce")?,
        });
    }

    // Everything a mail needs is read here, through the transaction: the sweep holds one
    // connection, and only the sending waits for the commit.
    let mut mails: Vec<(Uuid, Locale, String, mail_text::Email)> = Vec::new();
    for guest in due.into_iter().filter(|guest| guest.announce) {
        let managers = managers_of(&txn, guest.space_id, guest.user_id).await?;
        for manager in &managers {
            insert_notice(&txn, KIND_SOON, *manager, &guest, now).await?;
        }
        if guest.days == 1 {
            insert_notice(&txn, KIND_ENDING, guest.user_id, &guest, now).await?;
        }
        // The one who invited them, when they can still manage them, is the only one mailed.
        let mailed: Vec<Uuid> = match guest.invited_by.filter(|who| managers.contains(who)) {
            Some(inviter) => vec![inviter],
            None => managers,
        };
        report.reminded += 1;
        for to in mailed {
            if let Some(mail) = prepare_mail(state, &txn, to, &guest).await {
                mails.push((to, mail.0, mail.1, mail.2));
            }
        }
    }
    txn.commit().await?;

    // Mail after the commit: a mail that fails is not retried, the notice is there to be read.
    for (to, locale, address, email) in mails {
        if let Err(error) = state.mailer.send(&address, &email).await {
            tracing::warn!(%error, "could not send a guest expiry reminder by mail");
        }
        report.mailed.push((to, locale));
    }
    Ok(())
}

/// Who may manage `guest` in the space: holds `members.manage` and ranks above them.
async fn managers_of<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    guest: Uuid,
) -> Result<Vec<Uuid>, DbErr> {
    let Some(guest_rank) = delegation::rank_of(db, space_id, guest).await? else {
        return Ok(Vec::new());
    };
    let holders = check::space_holders(db, space_id, Permission::MembersManage).await?;
    let mut found = Vec::new();
    for holder in holders {
        if holder == guest {
            continue;
        }
        let above = delegation::actor_rank(db, space_id, holder)
            .await?
            .is_some_and(|rank| rank.outranks(guest_rank));
        if above {
            found.push(holder);
        }
    }
    found.sort();
    found.dedup();
    Ok(found)
}

async fn insert_notice<C: ConnectionTrait>(
    db: &C,
    kind: &str,
    to: Uuid,
    guest: &Due,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    let payload = Payload {
        space_id: guest.space_id,
        user_id: guest.user_id,
        ends_at: rfc3339(guest.expires_at),
        days: guest.days,
    };
    notifications::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(to),
        kind: Set(kind.to_owned()),
        conversation_id: Set(None),
        message_id: Set(None),
        event_id: Set(None),
        occurrence_start: Set(None),
        payload: Set(Some(
            serde_json::to_value(payload).map_err(|e| DbErr::Custom(e.to_string()))?,
        )),
        actor_id: Set(None),
        created_at: Set(now),
        read_at: Set(None),
        // Mailed here, in its own message: the unread digest leaves it alone.
        email_handled_at: Set(Some(now)),
    }
    .insert(db)
    .await?;
    Ok(())
}

/// The reminder mail for `to`, in their language, when they want mail: its language, their
/// address and the message. `None` when no mail is wanted.
async fn prepare_mail<C: ConnectionTrait>(
    state: &AppState,
    db: &C,
    to: Uuid,
    guest: &Due,
) -> Option<(Locale, String, mail_text::Email)> {
    let reader = users::Entity::find_by_id(to).one(db).await.ok()??;
    let settings = prefs::load(db, to).await.ok()?;
    if !settings.enabled || !settings.email {
        return None;
    }
    let guest_name = users::Entity::find_by_id(guest.user_id)
        .one(db)
        .await
        .ok()??
        .display_name;
    let space = spaces::Entity::find_by_id(guest.space_id)
        .one(db)
        .await
        .ok()??;
    let locale = Locale::parse(reader.locale.as_deref());
    let ends = end_text(locale, guest.expires_at, &reader_time_zone(Some(&reader)));
    let email = mail_text::guest_expiry_reminder(
        locale,
        &GuestExpiryWords {
            guest: &guest_name,
            space: &space.name,
            ends: &ends,
            days: guest.days,
            link: &state.mailer.base_url,
        },
        &state.mailer.instance_name(),
    );
    Some((locale, reader.email, email))
}

async fn expire(
    state: &AppState,
    now: OffsetDateTime,
    space: Option<Uuid>,
    report: &mut Report,
) -> Result<(), DbErr> {
    let txn = state.db.begin().await?;
    let rows = txn
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "WITH picked AS ( \
                SELECT space_id, user_id FROM space_members \
                 WHERE standing = 'guest' AND expires_at IS NOT NULL \
                   AND expires_at <= $1::timestamptz AND expiry_stage IS DISTINCT FROM 0 \
                   AND ($2::uuid IS NULL OR space_id = $2) \
                 ORDER BY space_id, user_id FOR UPDATE) \
             UPDATE space_members m SET expiry_stage = 0 \
               FROM picked p WHERE m.space_id = p.space_id AND m.user_id = p.user_id \
             RETURNING m.space_id, m.user_id, m.role",
            [now.into(), space.into()],
        ))
        .await?;
    let mut closed = Vec::new();
    for row in rows {
        let space_id: Uuid = row.try_get("", "space_id")?;
        let user_id: Uuid = row.try_get("", "user_id")?;
        let role: String = row.try_get("", "role")?;
        audit::record(
            &txn,
            space_id,
            None,
            Action::MemberExpired,
            Target::Member(user_id),
            serde_json::json!({ "role": role }),
        )
        .await?;
        closed.push((space_id, user_id));
    }
    txn.commit().await?;

    // After the commit, once per space: the people still in it, and the guests who just left. Best
    // effort: a crash between the commit and here loses the event, and the clients, which ask
    // again what they may do on their next request, catch up.
    let spaces: BTreeSet<Uuid> = closed.iter().map(|(space, _)| *space).collect();
    for space in spaces {
        let gone: Vec<Uuid> = closed
            .iter()
            .filter(|(of, _)| *of == space)
            .map(|(_, user)| *user)
            .collect();
        changed::announce_to(state, space, &gone).await;
    }
    report.expired.extend(closed);
    Ok(())
}

async fn purge(
    state: &AppState,
    now: OffsetDateTime,
    space: Option<Uuid>,
    report: &mut Report,
) -> Result<(), DbErr> {
    let txn = state.db.begin().await?;
    let rows = txn
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT space_id, user_id, role FROM space_members \
             WHERE standing = 'guest' AND expires_at IS NOT NULL \
               AND expires_at <= $1::timestamptz - make_interval(days => $3) \
               AND ($2::uuid IS NULL OR space_id = $2) \
             ORDER BY space_id, user_id FOR UPDATE",
            [now.into(), space.into(), (KEEP_DAYS as i32).into()],
        ))
        .await?;
    for row in rows {
        let space_id: Uuid = row.try_get("", "space_id")?;
        let user_id: Uuid = row.try_get("", "user_id")?;
        let role: String = row.try_get("", "role")?;
        // Channel rows first; group and role rows go with the membership (their keys cascade).
        let channel_ids: Vec<Uuid> = channels::Entity::find()
            .filter(channels::Column::SpaceId.eq(space_id))
            .all(&txn)
            .await?
            .into_iter()
            .map(|channel| channel.id)
            .collect();
        if !channel_ids.is_empty() {
            channel_members::Entity::delete_many()
                .filter(channel_members::Column::UserId.eq(user_id))
                .filter(channel_members::Column::ChannelId.is_in(channel_ids))
                .exec(&txn)
                .await?;
        }
        space_members::Entity::delete_by_id((space_id, user_id))
            .exec(&txn)
            .await?;
        audit::record(
            &txn,
            space_id,
            None,
            Action::MemberPurged,
            Target::Member(user_id),
            serde_json::json!({ "role": role }),
        )
        .await?;
        report.purged += 1;
    }
    txn.commit().await
}

/// Draw guest notices: which guest, of which space, until when. The feed carries them only for a
/// client that asked (`guest_notices=true`), so an app written before them never sees a kind it
/// cannot draw.
pub async fn hydrate<C: ConnectionTrait>(
    db: &C,
    rows: Vec<notifications::Model>,
) -> Result<Vec<NotificationDto>, DbErr> {
    let mut drawn = Vec::new();
    for row in rows {
        let Some(payload) = row
            .payload
            .clone()
            .and_then(|value| serde_json::from_value::<Payload>(value).ok())
        else {
            continue;
        };
        let space_name = spaces::Entity::find_by_id(payload.space_id)
            .one(db)
            .await?
            .map(|space| space.name)
            .unwrap_or_default();
        let guest_name = users::Entity::find_by_id(payload.user_id)
            .one(db)
            .await?
            .map(|user| user.display_name);
        let about_someone = row.kind == KIND_SOON;
        drawn.push(NotificationDto {
            id: row.id,
            kind: row.kind.clone(),
            conversation_id: None,
            space_id: Some(payload.space_id),
            channel_name: None,
            space_name,
            message_id: None,
            actor_id: about_someone.then_some(payload.user_id),
            actor_name: if about_someone { guest_name } else { None },
            preview: String::new(),
            created_at: rfc3339(row.created_at),
            read: row.read_at.is_some(),
            event_id: None,
            recurrence_id: None,
            event_title: None,
            event_start: None,
            event_all_day: None,
            event_location: None,
            calendar_name: None,
            event_changes: None,
            event_my_status: None,
            emoji: None,
            ends_at: Some(payload.ends_at),
            days_left: Some(payload.days),
        });
    }
    Ok(drawn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn the_end_is_written_in_the_readers_time_zone() {
        // 23:30 UTC on 19 November is already the 20th in Paris.
        let end = datetime!(2026-11-19 23:30 UTC);
        assert_eq!(
            end_text(Locale::Fr, end, "Europe/Paris"),
            "20 novembre 2026"
        );
        assert_eq!(
            end_text(Locale::Fr, end, "America/New_York"),
            "19 novembre 2026"
        );
        // An unknown zone falls back to the instance's, never to a guess in UTC.
        assert_eq!(
            end_text(Locale::Fr, end, "Nowhere/Land"),
            "20 novembre 2026"
        );
    }
}
