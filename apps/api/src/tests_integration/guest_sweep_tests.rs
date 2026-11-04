//! The guest sweep against a real database: reminders at seven days and one day, the close at the
//! date, the purge after ninety days. The sweep takes the moment it runs "as of" as an argument, so
//! a test moves the clock without waiting.

use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

use sea_orm::QueryOrder;

use crate::auth::mail_text::Locale;
use crate::permissions::guest_expiry::{self, Report};

/// A space with its owner, an administrator who invited nobody yet, and a plain member.
struct Fx {
    space: Uuid,
    owner: Uuid,
    admin: Uuid,
    member: Uuid,
}

async fn fx(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Sweep").await;
    let admin = make_user(&app.db, "admin").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    Fx {
        space,
        owner,
        admin,
        member,
    }
}

/// A guest ending `interval` from now who joined a month ago, invited by `inviter`.
async fn old_guest(app: &TestApp, space: Uuid, interval: &str, inviter: Option<Uuid>) -> Uuid {
    let guest = guest_ending(&app.db, space, interval).await;
    exec(
        &app.db,
        "UPDATE space_members SET joined_at = now() - interval '30 days', invited_by = $3 \
         WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), guest.into(), inviter.into()],
    )
    .await
    .expect("history");
    guest
}

/// One sweep of `space` (tests share a database, so each sweeps only its own space).
async fn sweep(app: &TestApp, space: Uuid, now: OffsetDateTime) -> Report {
    guest_expiry::sweep_in(&app.state, now, Some(space))
        .await
        .expect("sweep")
}

/// The guest notices a person holds, `(kind, payload)`, oldest first.
async fn notices(app: &TestApp, user: Uuid) -> Vec<(String, Value)> {
    notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(user))
        .filter(notifications::Column::Kind.like("guest_%"))
        .order_by_asc(notifications::Column::CreatedAt)
        .all(&app.db)
        .await
        .expect("notices")
        .into_iter()
        .map(|n| (n.kind, n.payload.expect("payload")))
        .collect()
}

async fn stage(app: &TestApp, space: Uuid, user: Uuid) -> Option<i16> {
    space_members::Entity::find_by_id((space, user))
        .one(&app.db)
        .await
        .expect("row")
        .expect("present")
        .expiry_stage
}

async fn audit_count(app: &TestApp, space: Uuid, action: &str) -> i64 {
    let row = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT count(*) AS n FROM space_audit_log \
             WHERE space_id = $1 AND action = $2 AND actor_id IS NULL",
            vec![space.into(), action.into()],
        ))
        .await
        .expect("count")
        .expect("row");
    row.try_get("", "n").expect("n")
}

/// Every frame type that reaches `ws` within a short window.
async fn frame_types(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1000);
    let mut seen = Vec::new();
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Ok(WsMessage::Text(text)) = frame {
            if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                if let Some(kind) = event["type"].as_str() {
                    seen.push(kind.to_owned());
                }
            }
        }
    }
    seen
}

#[tokio::test]
async fn seven_days_before_notifies_managers_only() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;

    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.reminded, 1);

    for manager in [fx.owner, fx.admin] {
        let held = notices(&app, manager).await;
        assert_eq!(held.len(), 1, "{manager}: {held:?}");
        assert_eq!(held[0].0, "guest_expiry_soon");
        assert_eq!(held[0].1["days"], 7);
        assert_eq!(held[0].1["user_id"], guest.to_string());
        assert_eq!(held[0].1["space_id"], fx.space.to_string());
        assert!(held[0].1["ends_at"].is_string());
    }
    assert!(
        notices(&app, guest).await.is_empty(),
        "the guest is not told yet"
    );
    assert!(notices(&app, fx.member).await.is_empty());
    assert_eq!(stage(&app, fx.space, guest).await, Some(7));
}

#[tokio::test]
async fn the_day_before_notifies_the_guest_and_the_managers() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = old_guest(&app, fx.space, "20 hours", Some(fx.admin)).await;

    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.reminded, 1);

    let own = notices(&app, guest).await;
    assert_eq!(own.len(), 1, "{own:?}");
    assert_eq!(own[0].0, "guest_access_ending");
    assert_eq!(own[0].1["days"], 1);
    for manager in [fx.owner, fx.admin] {
        let held = notices(&app, manager).await;
        assert_eq!(held.len(), 1, "{held:?}");
        assert_eq!(held[0].0, "guest_expiry_soon");
        assert_eq!(held[0].1["days"], 1);
    }
    assert_eq!(stage(&app, fx.space, guest).await, Some(1));
    // The two thresholds are two notices: a later sweep at the 7 day mark did not leave a 7.
    assert!(notices(&app, fx.member).await.is_empty());
}

#[tokio::test]
async fn the_inviter_is_mailed_first_and_alone_when_able() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    // Able: the administrator invited the guest. Only they are mailed; the owner gets the notice.
    old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;
    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.mailed, vec![(fx.admin, Locale::Fr)]);
    assert_eq!(notices(&app, fx.owner).await.len(), 1);

    // Not able any more (a plain member invited them, or nobody did): every manager is mailed.
    let other_owner = make_user(&app.db, "other").await;
    let space = crate::testkit::make_space(&app.db, other_owner, "Other").await;
    let second = make_user(&app.db, "second").await;
    crate::testkit::add_member(&app.db, space, second, "admin").await;
    let plain = make_user(&app.db, "plain").await;
    crate::testkit::add_member(&app.db, space, plain, "member").await;
    old_guest(&app, space, "6 days", Some(plain)).await;
    let report = sweep(&app, space, OffsetDateTime::now_utc()).await;
    let mut mailed: Vec<Uuid> = report.mailed.iter().map(|(user, _)| *user).collect();
    mailed.sort();
    let mut expected = vec![other_owner, second];
    expected.sort();
    assert_eq!(mailed, expected);
}

#[tokio::test]
async fn the_mail_is_in_the_readers_language() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    exec(
        &app.db,
        "UPDATE users SET locale = 'en' WHERE id = $1",
        vec![fx.admin.into()],
    )
    .await
    .expect("locale");
    old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;
    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.mailed, vec![(fx.admin, Locale::En)]);
}

#[tokio::test]
async fn a_sweep_is_idempotent_and_two_concurrent_sweeps_send_once() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;
    let now = OffsetDateTime::now_utc();

    let (a, b) = tokio::join!(sweep(&app, fx.space, now), sweep(&app, fx.space, now));
    assert_eq!(a.reminded + b.reminded, 1, "{a:?} {b:?}");
    assert_eq!(notices(&app, fx.owner).await.len(), 1);
    assert_eq!(notices(&app, fx.admin).await.len(), 1);

    let again = sweep(&app, fx.space, now).await;
    assert_eq!(again.reminded, 0);
    assert!(again.mailed.is_empty());
    assert_eq!(notices(&app, fx.owner).await.len(), 1);
    assert_eq!(stage(&app, fx.space, guest).await, Some(7));
}

#[tokio::test]
async fn moving_the_date_restarts_the_reminders() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;
    let now = OffsetDateTime::now_utc();
    assert_eq!(sweep(&app, fx.space, now).await.reminded, 1);

    // The date moves a month on: the reminder stage starts over, and nothing is due.
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() + interval '30 days' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("move");
    guest_expiry::restart(&app.db, fx.space, guest)
        .await
        .expect("restart");
    assert_eq!(stage(&app, fx.space, guest).await, None);
    assert_eq!(sweep(&app, fx.space, now).await.reminded, 0);

    // A month on, the seven day reminder is due again, and it is sent again.
    let later = now + time::Duration::days(24);
    assert_eq!(sweep(&app, fx.space, later).await.reminded, 1);
    assert_eq!(notices(&app, fx.owner).await.len(), 2);
}

#[tokio::test]
async fn a_guest_invited_with_three_days_left_gets_the_one_day_notice_only() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    // Joined now, ends in three days: the seven day mark was never crossed as a guest.
    let guest = guest_ending(&app.db, fx.space, "3 days").await;
    let now = OffsetDateTime::now_utc();

    let first = sweep(&app, fx.space, now).await;
    assert_eq!(first.reminded, 0);
    assert!(notices(&app, fx.owner).await.is_empty());
    assert_eq!(
        stage(&app, fx.space, guest).await,
        Some(7),
        "skipped, not forgotten"
    );

    let eve = sweep(&app, fx.space, now + time::Duration::hours(54)).await;
    assert_eq!(eve.reminded, 1);
    let held = notices(&app, fx.owner).await;
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].1["days"], 1);
    assert_eq!(notices(&app, guest).await.len(), 1);
}

#[tokio::test]
async fn expiry_is_audited_and_announced_once() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "-1 second").await;
    let owner_cookie = app.cookie_for(fx.owner).await;
    let guest_cookie = app.cookie_for(guest).await;
    let mut owner_ws = app.connect_ws(&owner_cookie).await;
    let mut guest_ws = app.connect_ws(&guest_cookie).await;
    frame_types(&mut owner_ws).await;
    frame_types(&mut guest_ws).await;

    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.expired, vec![(fx.space, guest)]);
    assert_eq!(stage(&app, fx.space, guest).await, Some(0));
    assert_eq!(audit_count(&app, fx.space, "member.expired").await, 1);

    let owner_frames = frame_types(&mut owner_ws).await;
    let guest_frames = frame_types(&mut guest_ws).await;
    let changed = |frames: &[String]| {
        frames
            .iter()
            .filter(|k| *k == "permissions.changed")
            .count()
    };
    assert_eq!(changed(&owner_frames), 1, "{owner_frames:?}");
    assert_eq!(changed(&guest_frames), 1, "{guest_frames:?}");

    // Nothing the second time.
    let again = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert!(again.expired.is_empty());
    assert_eq!(audit_count(&app, fx.space, "member.expired").await, 1);
    assert_eq!(changed(&frame_types(&mut owner_ws).await), 0);
}

#[tokio::test]
async fn an_expired_guest_is_told_once_and_nothing_after() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "-1 second").await;
    let cookie = app.cookie_for(guest).await;
    let mut ws = app.connect_ws(&cookie).await;
    frame_types(&mut ws).await;

    sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    let frames = frame_types(&mut ws).await;
    assert_eq!(frames, vec!["permissions.changed".to_owned()], "{frames:?}");
    // No reminder either: the date is behind them.
    assert!(notices(&app, guest).await.is_empty());
    assert!(notices(&app, fx.owner).await.is_empty());
}

#[tokio::test]
async fn an_expired_guest_leaves_every_audience() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "-1 second").await;
    let general: Uuid = spaces::Entity::find_by_id(fx.space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    for user in [fx.owner, fx.member, guest] {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member') \
             ON CONFLICT DO NOTHING",
            vec![general.into(), user.into()],
        )
        .await
        .expect("channel member");
    }
    let cookie = app.cookie_for(guest).await;
    let owner_cookie = app.cookie_for(fx.owner).await;
    let mut ws = app.connect_ws(&cookie).await;
    sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    frame_types(&mut ws).await;

    // After the date: a message, a typing frame and a read position in their channel.
    let sent = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{general}/messages"),
            &owner_cookie,
        )
        .json(&json!({ "body": "after the end" }))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status(), 201);
    let frames = frame_types(&mut ws).await;
    assert!(
        frames.is_empty(),
        "nothing reaches the ended guest: {frames:?}"
    );
}

#[tokio::test]
async fn after_90_days_the_row_is_purged_and_content_stays() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let gone = guest_ending(&app.db, fx.space, "-91 days").await;
    let kept = guest_ending(&app.db, fx.space, "-89 days").await;
    let general: Uuid = spaces::Entity::find_by_id(fx.space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    for user in [gone, kept] {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')",
            vec![general.into(), user.into()],
        )
        .await
        .expect("channel member");
    }
    let message = Uuid::new_v4();
    exec(
        &app.db,
        "INSERT INTO messages (id, conversation_id, author_id, kind, body) \
         VALUES ($1, $2, $3, 'message', 'still here')",
        vec![message.into(), general.into(), gone.into()],
    )
    .await
    .expect("message");

    let report = sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    assert_eq!(report.purged, 1);
    assert!(space_members::Entity::find_by_id((fx.space, gone))
        .one(&app.db)
        .await
        .expect("read")
        .is_none());
    assert!(space_members::Entity::find_by_id((fx.space, kept))
        .one(&app.db)
        .await
        .expect("read")
        .is_some());
    let channel_rows = channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(gone))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(channel_rows, 0);
    assert!(messages::Entity::find_by_id(message)
        .one(&app.db)
        .await
        .expect("read")
        .is_some());
    assert_eq!(audit_count(&app, fx.space, "member.purged").await, 1);
    // A second sweep purges nothing more.
    assert_eq!(
        sweep(&app, fx.space, OffsetDateTime::now_utc())
            .await
            .purged,
        0
    );
}

#[tokio::test]
async fn the_sweep_does_nothing_on_a_member_or_an_owner() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    // A guest without an end date, a member and an owner: nobody has anything to be reminded of.
    let open = make_user(&app.db, "open").await;
    crate::testkit::add_member(&app.db, fx.space, open, "guest").await;
    let report = sweep(
        &app,
        fx.space,
        OffsetDateTime::now_utc() + time::Duration::days(400),
    )
    .await;
    assert_eq!(report.reminded, 0);
    assert!(report.expired.is_empty());
    assert_eq!(report.purged, 0);
    assert!(report.mailed.is_empty());
    for user in [fx.owner, fx.admin, fx.member, open] {
        assert!(notices(&app, user).await.is_empty());
    }
    assert_eq!(stage(&app, fx.space, open).await, None);
}

#[tokio::test]
async fn updated_clients_see_the_guest_notices_and_old_ones_do_not() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    old_guest(&app, fx.space, "6 days", Some(fx.admin)).await;
    sweep(&app, fx.space, OffsetDateTime::now_utc()).await;
    let cookie = app.cookie_for(fx.owner).await;

    let old: Value = app
        .req(reqwest::Method::GET, "/api/v1/notifications", &cookie)
        .send()
        .await
        .expect("feed")
        .json()
        .await
        .expect("json");
    assert!(
        old["notifications"].as_array().expect("list").is_empty(),
        "{old}"
    );
    assert_eq!(old["unread_count"], 0);

    let new: Value = app
        .req(
            reqwest::Method::GET,
            "/api/v1/notifications?guest_notices=true",
            &cookie,
        )
        .send()
        .await
        .expect("feed")
        .json()
        .await
        .expect("json");
    let list = new["notifications"].as_array().expect("list");
    assert_eq!(list.len(), 1, "{new}");
    assert_eq!(list[0]["kind"], "guest_expiry_soon");
    assert_eq!(list[0]["space_id"], fx.space.to_string());
    assert_eq!(list[0]["space_name"], "Sweep");
    assert_eq!(list[0]["days_left"], 7);
    assert!(list[0]["ends_at"].is_string());
    assert!(list[0]["actor_name"].is_string(), "the guest's name");
    assert_eq!(new["unread_count"], 1);
}

/// Two guests ending in six days, swept: the owner holds two unread guest notices.
async fn owner_with_two_notices(app: &TestApp) -> (Fx, String, Vec<Uuid>) {
    let fx = fx(app).await;
    old_guest(app, fx.space, "6 days", Some(fx.admin)).await;
    old_guest(app, fx.space, "6 days", Some(fx.admin)).await;
    assert_eq!(
        sweep(app, fx.space, OffsetDateTime::now_utc())
            .await
            .reminded,
        2
    );
    let ids = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(fx.owner))
        .filter(notifications::Column::Kind.like("guest_%"))
        .all(&app.db)
        .await
        .expect("rows")
        .into_iter()
        .map(|n| n.id)
        .collect();
    let cookie = app.cookie_for(fx.owner).await;
    (fx, cookie, ids)
}

#[tokio::test]
async fn the_guest_notices_are_never_pushed_nor_allowed_by_the_preferences() {
    use crate::notify::prefs::{allows, Delivery, NotificationPrefs};
    let prefs = NotificationPrefs::default();
    for kind in ["guest_expiry_soon", "guest_access_ending"] {
        for delivery in [Delivery::App, Delivery::Email] {
            assert!(!allows(kind, &prefs, None, delivery), "{kind}");
        }
    }
    let Some(app) = boot().await else { return };
    let (_fx, cookie, _ids) = owner_with_two_notices(&app).await;
    let pending: Value = app
        .req(reqwest::Method::GET, "/api/v1/push/pending", &cookie)
        .send()
        .await
        .expect("pending")
        .json()
        .await
        .expect("json");
    let items = pending["items"].as_array().expect("items");
    assert!(
        items
            .iter()
            .all(|i| !i["kind"].as_str().unwrap_or("").starts_with("guest_")),
        "{pending}"
    );
}

/// The `unread_count` of the next `notification.read` frame on `ws`.
async fn read_count(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<i64> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Ok(WsMessage::Text(text)) = frame {
            let event: Value = serde_json::from_str(text.as_str()).ok()?;
            if event["type"] == "notification.read" {
                return event["payload"]["unread_count"].as_i64();
            }
        }
    }
    None
}

#[tokio::test]
async fn a_read_announces_a_count_without_the_hidden_guest_notices() {
    let Some(app) = boot().await else { return };
    let (_fx, cookie, ids) = owner_with_two_notices(&app).await;
    let mut ws = app.connect_ws(&cookie).await;
    let status = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/notifications/{}/read", ids[0]),
            &cookie,
        )
        .send()
        .await
        .expect("read")
        .status();
    assert_eq!(status, 204);
    assert_eq!(
        read_count(&mut ws).await,
        Some(0),
        "the other notice is hidden, not counted"
    );
}

async fn unread(app: &TestApp, ids: &[Uuid]) -> u64 {
    notifications::Entity::find()
        .filter(notifications::Column::Id.is_in(ids.to_vec()))
        .filter(notifications::Column::ReadAt.is_null())
        .count(&app.db)
        .await
        .expect("count")
}

#[tokio::test]
async fn marking_all_read_leaves_the_guest_notices_to_clients_that_know_them() {
    let Some(app) = boot().await else { return };
    let (_fx, cookie, ids) = owner_with_two_notices(&app).await;
    let put = |path: &'static str| app.req(reqwest::Method::PUT, path, &cookie).send();
    assert_eq!(
        put("/api/v1/notifications/read")
            .await
            .expect("put")
            .status(),
        204
    );
    assert_eq!(
        unread(&app, &ids).await,
        2,
        "an app that cannot see them does not clear them"
    );
    assert_eq!(
        put("/api/v1/notifications/read?guest_notices=true")
            .await
            .expect("put")
            .status(),
        204
    );
    assert_eq!(unread(&app, &ids).await, 0);
}
