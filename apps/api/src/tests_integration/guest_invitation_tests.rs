//! An invitation can carry the guest's end date, applied when they join. Same harness as the
//! parent module.

use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

use crate::messaging::dto::rfc3339;

struct Fx {
    space: Uuid,
    owner_cookie: String,
}

async fn fx(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Invites").await;
    let owner_cookie = app.cookie_for(owner).await;
    Fx {
        space,
        owner_cookie,
    }
}

async fn invite(app: &TestApp, fx: &Fx, body: Value) -> (u16, Value) {
    let response = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space),
            &fx.owner_cookie,
        )
        .json(&body)
        .send()
        .await
        .expect("create invitation");
    (
        response.status().as_u16(),
        response.json().await.unwrap_or(Value::Null),
    )
}

async fn accept(app: &TestApp, token: &str, cookie: &str) -> (u16, Value) {
    let response = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{token}/accept"),
            cookie,
        )
        .send()
        .await
        .expect("accept");
    (
        response.status().as_u16(),
        response.json().await.unwrap_or(Value::Null),
    )
}

fn in_days(days: i64) -> OffsetDateTime {
    OffsetDateTime::now_utc() + time::Duration::days(days)
}

async fn invitation_of(app: &TestApp, token: &str) -> space_invitations::Model {
    space_invitations::Entity::find()
        .filter(space_invitations::Column::TokenHash.eq(crate::auth::tokens::digest(token)))
        .one(&app.db)
        .await
        .expect("query")
        .expect("invitation")
}

async fn expires_of(app: &TestApp, space: Uuid, user: Uuid) -> Option<OffsetDateTime> {
    space_members::Entity::find_by_id((space, user))
        .one(&app.db)
        .await
        .expect("query")
        .and_then(|row| row.expires_at)
}

async fn joined_entries(app: &TestApp, space: Uuid) -> Vec<Value> {
    app.db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT details FROM space_audit_log WHERE space_id = $1 AND action = 'member.joined' \
             ORDER BY at, id",
            [space.into()],
        ))
        .await
        .expect("log")
        .into_iter()
        .map(|row| row.try_get("", "details").expect("details"))
        .collect()
}

#[tokio::test]
async fn a_guest_invitation_carries_its_end_date() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let end = in_days(30);
    let (status, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(end) }),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let echoed = created["guest_expires_at"].as_str().expect("echoed");
    let echoed = OffsetDateTime::parse(echoed, &time::format_description::well_known::Rfc3339)
        .expect("rfc3339");
    assert!((echoed - end).whole_seconds().abs() <= 1);

    let listed: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/invitations", fx.space),
            &fx.owner_cookie,
        )
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    assert_eq!(listed[0]["guest_expires_at"], created["guest_expires_at"]);

    // Older apps send no such field: no end date, as before.
    let (status, plain) = invite(&app, &fx, json!({ "role": "guest" })).await;
    assert_eq!(status, 201);
    assert!(plain["guest_expires_at"].is_null());

    // Refused: already past, beyond five years, or not a date.
    for bad in [
        rfc3339(in_days(-1)),
        rfc3339(in_days(365 * 5 + 30)),
        "next week".to_owned(),
    ] {
        let (status, body) = invite(
            &app,
            &fx,
            json!({ "role": "guest", "guest_expires_at": bad }),
        )
        .await;
        assert_eq!(status, 400, "{bad}: {body}");
        assert_eq!(body["error"], "bad_expiry", "{bad}");
    }
}

#[tokio::test]
async fn an_end_date_on_a_member_invitation_is_refused() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let date = rfc3339(in_days(10));
    for body in [
        json!({ "role": "member", "guest_expires_at": date }),
        json!({ "guest_expires_at": date }),
        json!({ "role": "admin", "guest_expires_at": date }),
    ] {
        let (status, answer) = invite(&app, &fx, body.clone()).await;
        assert_eq!(status, 400, "{body}: {answer}");
        assert_eq!(answer["error"], "guest_only", "{body}");
    }
    let rows = space_invitations::Entity::find()
        .filter(space_invitations::Column::SpaceId.eq(fx.space))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(rows, 0, "nothing was stored");
}

#[tokio::test]
async fn accepting_sets_expires_at_on_the_new_guest() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let end = in_days(14);
    let (_, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(end) }),
    )
    .await;
    let token = token_of(created["url"].as_str().expect("url"));
    let newcomer = make_user(&app.db, "newcomer").await;
    let cookie = app.cookie_for(newcomer).await;

    let (status, space) = accept(&app, &token, &cookie).await;
    assert_eq!(status, 200, "{space}");
    assert_eq!(space["role"], "guest");
    let stored = expires_of(&app, fx.space, newcomer).await.expect("an end");
    assert!((stored - end).whole_seconds().abs() <= 1);
    let invitation = invitation_of(&app, &token).await;
    assert_eq!(invitation.uses, 1);

    let logged = joined_entries(&app, fx.space).await;
    let joined = logged.last().expect("a join was logged");
    assert_eq!(joined["role"], "guest");
    assert_eq!(
        joined["guest_expires_at"].as_str().map(str::to_owned),
        Some(rfc3339(invitation.guest_expires_at.expect("stored")))
    );

    // Without an end date on the invitation, the guest has none.
    let (_, open) = invite(&app, &fx, json!({ "role": "guest" })).await;
    let token = token_of(open["url"].as_str().expect("url"));
    let other = make_user(&app.db, "other").await;
    let (status, _) = accept(&app, &token, &app.cookie_for(other).await).await;
    assert_eq!(status, 200);
    assert!(expires_of(&app, fx.space, other).await.is_none());
    let logged = joined_entries(&app, fx.space).await;
    assert!(logged.last().expect("join")["guest_expires_at"].is_null());
}

#[tokio::test]
async fn an_invitation_past_its_guest_end_is_unusable() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let (_, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(in_days(2)) }),
    )
    .await;
    let token = token_of(created["url"].as_str().expect("url"));
    exec(
        &app.db,
        "UPDATE space_invitations SET guest_expires_at = now() - interval '1 second' \
         WHERE space_id = $1",
        vec![fx.space.into()],
    )
    .await
    .expect("move the end into the past");

    let newcomer = make_user(&app.db, "late").await;
    let (status, _) = accept(&app, &token, &app.cookie_for(newcomer).await).await;
    assert_eq!(status, 404);
    assert_eq!(invitation_of(&app, &token).await.uses, 0, "no use spent");
    assert!(space_members::Entity::find_by_id((fx.space, newcomer))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());

    let preview = app
        .http
        .get(format!("{}/api/v1/invitations/{token}", app.base))
        .send()
        .await
        .expect("preview");
    assert_eq!(preview.status(), 404, "the preview is as unusable");
}

#[tokio::test]
async fn an_ended_guest_cannot_come_back_through_a_link() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let ended = guest_ending(&app.db, fx.space, "-1 second").await;
    let before = expires_of(&app, fx.space, ended).await;
    let (_, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(in_days(30)) }),
    )
    .await;
    let token = token_of(created["url"].as_str().expect("url"));
    let channels_before = channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(ended))
        .count(&app.db)
        .await
        .expect("count");

    let (status, _) = accept(&app, &token, &app.cookie_for(ended).await).await;
    assert_eq!(status, 404);
    assert_eq!(
        expires_of(&app, fx.space, ended).await,
        before,
        "still ended"
    );
    assert_eq!(invitation_of(&app, &token).await.uses, 0);
    let channels_after = channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(ended))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(channels_before, channels_after, "no channel row added");
}

#[tokio::test]
async fn an_active_guest_accepting_again_changes_nothing() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "1 day").await;
    let before = expires_of(&app, fx.space, guest).await;
    let (_, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(in_days(60)) }),
    )
    .await;
    let token = token_of(created["url"].as_str().expect("url"));
    let joined_before = joined_entries(&app, fx.space).await.len();

    let (status, space) = accept(&app, &token, &app.cookie_for(guest).await).await;
    assert_eq!(status, 200, "{space}");
    assert_eq!(expires_of(&app, fx.space, guest).await, before);
    assert_eq!(invitation_of(&app, &token).await.uses, 0, "no use spent");
    assert_eq!(joined_entries(&app, fx.space).await.len(), joined_before);
}

#[tokio::test]
async fn the_card_counts_active_people_only() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    guest_ending(&app.db, fx.space, "-1 second").await;
    guest_ending(&app.db, fx.space, "2 days").await;
    let (_, created) = invite(&app, &fx, json!({ "role": "guest" })).await;
    let token = token_of(created["url"].as_str().expect("url"));
    let newcomer = make_user(&app.db, "newcomer").await;
    let (status, space) = accept(&app, &token, &app.cookie_for(newcomer).await).await;
    assert_eq!(status, 200);
    assert_eq!(
        space["members"], 3,
        "the owner, the running guest and the newcomer; not the ended one: {space}"
    );
}

#[tokio::test]
async fn a_dead_guest_invitation_reads_expired_in_the_list() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(in_days(2)) }),
    )
    .await;
    exec(
        &app.db,
        "UPDATE space_invitations SET guest_expires_at = now() - interval '1 second' \
         WHERE space_id = $1",
        vec![fx.space.into()],
    )
    .await
    .expect("move the end into the past");
    let listed: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/invitations", fx.space),
            &fx.owner_cookie,
        )
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    assert_eq!(listed[0]["usable"], false);
    assert_eq!(listed[0]["status"], "expired");
}

#[tokio::test]
async fn a_dead_addressed_guest_invitation_no_longer_skips_email_verification() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let address = format!("late-{}@example.test", Uuid::new_v4().simple());
    let (_, created) = invite(
        &app,
        &fx,
        json!({
            "role": "guest",
            "email": address,
            "guest_expires_at": rfc3339(in_days(2)),
        }),
    )
    .await;
    let token = token_of(created["url"].as_str().expect("url"));
    exec(
        &app.db,
        "UPDATE space_invitations SET guest_expires_at = now() - interval '1 second' \
         WHERE space_id = $1",
        vec![fx.space.into()],
    )
    .await
    .expect("move the end into the past");
    let registered = app
        .http
        .post(format!("{}/api/v1/auth/register", app.base))
        .json(&json!({
            "email": address,
            "display_name": "Late",
            "password": "Correct-Horse-42!",
            "invitation_token": token,
        }))
        .send()
        .await
        .expect("register");
    assert_eq!(registered.status(), 201);
    let account: Value = registered.json().await.expect("json");
    assert_eq!(account["active"], false, "a dead invitation proves nothing");
}

#[tokio::test]
async fn an_offset_end_date_is_stored_as_the_instant_it_names() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let end = in_days(10);
    let offset = time::UtcOffset::from_hms(2, 0, 0).expect("offset");
    let (status, created) = invite(
        &app,
        &fx,
        json!({ "role": "guest", "guest_expires_at": rfc3339(end.to_offset(offset)) }),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let token = token_of(created["url"].as_str().expect("url"));
    let newcomer = make_user(&app.db, "offset").await;
    let (status, _) = accept(&app, &token, &app.cookie_for(newcomer).await).await;
    assert_eq!(status, 200);
    let stored = expires_of(&app, fx.space, newcomer).await.expect("an end");
    assert!((stored - end).whole_seconds().abs() <= 1);
}
