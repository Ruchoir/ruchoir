//! A guest becomes a member and a member a guest (permissions lot 5, ruling 5): the seats check
//! inside the write under a lock, the end date and stage cleared, the visibility a guest loses, the
//! audit line and the announcement. Same harness as the parent module.

use super::delegation_tests::{assign, make_role};
use super::guest_expiry_routes_tests::{audit, call, frames, row};
use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

use crate::edition::{seats_used, Edition, Entitlement, SeatCheck};

/// An edition selling `0` seats, counted for real from the space's owners and members.
struct Seats(u32);

#[async_trait::async_trait]
impl Edition for Seats {
    fn name(&self) -> &'static str {
        "seats"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Enterprise {
            seats: self.0,
            valid_until: time::macros::datetime!(2037-12-31 0:00 UTC),
        })
    }

    async fn seat_check(
        &self,
        db: &sea_orm::DatabaseTransaction,
        space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(if seats_used(db, space_id).await? >= self.0 {
            SeatCheck::Full { seats: self.0 }
        } else {
            SeatCheck::Allowed
        })
    }

    fn routes(&self) -> axum::Router<AppState> {
        axum::Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

struct Fx {
    space: Uuid,
    owner: Uuid,
    admin: Uuid,
    member: Uuid,
}

/// An owner, an administrator and a member: three seats used.
async fn fx(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Standing").await;
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

async fn boot_seats(limit: u32) -> Option<TestApp> {
    boot_as(Arc::new(Seats(limit)), None, |_| {}).await
}

/// [`boot_seats`] with a database pool of `pool` connections.
async fn boot_seats_pool(limit: u32, pool: u32) -> Option<TestApp> {
    boot_as(Arc::new(Seats(limit)), None, move |config| {
        config.db_max_connections = pool;
    })
    .await
}

async fn set_role(
    app: &TestApp,
    space: Uuid,
    user: Uuid,
    cookie: &str,
    body: Value,
) -> (u16, Value) {
    call(
        app,
        reqwest::Method::PATCH,
        format!("/api/v1/spaces/{space}/members/{user}"),
        cookie,
        Some(body),
    )
    .await
}

async fn used(app: &TestApp, space: Uuid) -> u32 {
    seats_used(&app.db, space).await.expect("used")
}

#[tokio::test]
async fn a_full_space_refuses_passer_membre() {
    let Some(app) = boot_seats(3).await else {
        return;
    };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let cookie = app.cookie_for(fx.owner).await;
    for role in ["member", "admin"] {
        let (status, body) =
            set_role(&app, fx.space, guest, &cookie, json!({ "role": role })).await;
        assert_eq!(status, 402, "{role}: {body}");
        assert_eq!(body["error"], "seats_full");
        assert_eq!(body["seats"], 3);
        assert_eq!(body["pricing_url"], app.config.pricing_url.as_str());
    }
    let after = row(&app, fx.space, guest).await;
    assert_eq!(after.role, "guest");
    assert!(after.expires_at.is_some());
    assert!(audit(&app, fx.space, "member.role_changed")
        .await
        .is_empty());
    assert!(audit(&app, fx.space, "member.standing_changed")
        .await
        .is_empty());
    assert_eq!(used(&app, fx.space).await, 3);
}

#[tokio::test]
async fn two_promotions_for_one_seat_admit_one() {
    // A pool smaller than the callers: those waiting on the lock must not starve the holder.
    let Some(app) = boot_seats_pool(4, 3).await else {
        return;
    };
    let fx = fx(&app).await;
    let mut guests = Vec::new();
    for _ in 0..6 {
        guests.push(guest_ending(&app.db, fx.space, "10 days").await);
    }
    let cookie = app.cookie_for(fx.owner).await;
    let calls = guests
        .iter()
        .map(|guest| set_role(&app, fx.space, *guest, &cookie, json!({ "role": "member" })));
    let mut statuses: Vec<u16> = futures_util::future::join_all(calls)
        .await
        .into_iter()
        .map(|(status, _)| status)
        .collect();
    statuses.sort_unstable();
    assert_eq!(statuses, vec![200, 402, 402, 402, 402, 402]);
    assert_eq!(used(&app, fx.space).await, 4);
    let log = audit(&app, fx.space, "member.standing_changed").await;
    assert_eq!(log.len(), 1, "{log:?}");
}

#[tokio::test]
async fn an_ended_guest_cannot_be_promoted() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    let cookie = app.cookie_for(fx.owner).await;
    for role in ["member", "admin"] {
        let (status, body) = set_role(&app, fx.space, gone, &cookie, json!({ "role": role })).await;
        assert_eq!(status, 409, "{role}: {body}");
        assert_eq!(body["error"], "access_ended");
    }
    assert_eq!(row(&app, fx.space, gone).await.role, "guest");
    assert!(audit(&app, fx.space, "member.standing_changed")
        .await
        .is_empty());
}

#[tokio::test]
async fn passer_membre_clears_the_end_and_takes_a_seat() {
    let Some(app) = boot_seats(4).await else {
        return;
    };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "3 days").await;
    exec(
        &app.db,
        "UPDATE space_members SET expiry_stage = 1 WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("stage");
    assert_eq!(used(&app, fx.space).await, 3);
    let cookie = app.cookie_for(fx.owner).await;
    let (status, body) =
        set_role(&app, fx.space, guest, &cookie, json!({ "role": "member" })).await;
    assert_eq!(status, 200, "{body}");
    let after = row(&app, fx.space, guest).await;
    assert_eq!(
        (after.role.as_str(), after.standing.as_str()),
        ("member", "member")
    );
    assert!(after.expires_at.is_none());
    assert!(after.expiry_stage.is_none());
    assert_eq!(used(&app, fx.space).await, 4);
}

#[tokio::test]
async fn passer_invite_keeps_channels_and_loses_space_wide_visibility() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    let other = make_user(&app.db, "other").await;
    crate::testkit::add_member(&app.db, fx.space, other, "member").await;
    let general = make_channel(&app.db, fx.space, "lobby", "public").await;
    let open = make_channel(&app.db, fx.space, "open", "public").await;
    let shared = make_channel(&app.db, fx.space, "shared", "private").await;
    for user in [fx.member, other] {
        add_channel_member(&app.db, shared, user).await;
    }
    // A custom role that reaches above the guest ceiling: kept assigned, clamped.
    let desk = make_role(
        &app.db,
        fx.space,
        "Desk",
        50,
        &["members.manage", "channel.manage"],
    )
    .await;
    assign(&app.db, fx.space, fx.member, desk).await;
    let space_rights = |user: Uuid| {
        let db = app.db.clone();
        let space = fx.space;
        async move {
            crate::permissions::check::space_rights(&db, space, user)
                .await
                .expect("rights")
        }
    };
    use crate::permissions::catalogue::Permission;
    let sees = |channel: Uuid| {
        let db = app.db.clone();
        let (space, user) = (fx.space, fx.member);
        async move {
            crate::permissions::check::can(
                &db,
                space,
                user,
                crate::permissions::load::Resource::Channel(channel),
                Permission::ChannelView,
            )
            .await
            .expect("can")
        }
    };
    assert!(sees(general).await && sees(open).await && sees(shared).await);
    assert!(space_rights(fx.member)
        .await
        .contains(Permission::MembersManage));
    assert_eq!(used(&app, fx.space).await, 4);

    let cookie = app.cookie_for(fx.owner).await;
    let (status, body) = set_role(
        &app,
        fx.space,
        fx.member,
        &cookie,
        json!({ "role": "guest" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    assert!(sees(shared).await, "a joined channel stays");
    assert!(!sees(open).await, "a public channel not joined goes");
    assert!(
        !sees(general).await,
        "another public channel not joined goes too"
    );
    let rights = space_rights(fx.member).await;
    assert!(
        !rights.contains(Permission::MembersManage),
        "clamped by the ceiling"
    );
    assert!(!rights.contains(Permission::ChannelManage));
    let kept = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT count(*)::bigint AS n FROM space_role_assignments WHERE space_id = $1 AND user_id = $2 AND role_id = $3",
            [fx.space.into(), fx.member.into(), desk.into()],
        ))
        .await
        .expect("q")
        .expect("row")
        .try_get::<i64>("", "n")
        .expect("n");
    assert_eq!(kept, 1, "the role stays assigned");
    assert_eq!(used(&app, fx.space).await, 3, "the seat is freed");

    // The directory narrows to the people they share a conversation with.
    let (status, list) = call(
        &app,
        reqwest::Method::GET,
        format!("/api/v1/spaces/{}/members", fx.space),
        &app.cookie_for(fx.member).await,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let ids: Vec<String> = list
        .as_array()
        .expect("list")
        .iter()
        .map(|m| m["user_id"].as_str().expect("id").to_owned())
        .collect();
    assert!(ids.contains(&other.to_string()), "{ids:?}");
    assert!(!ids.contains(&fx.admin.to_string()), "{ids:?}");
}

#[tokio::test]
async fn passer_invite_with_a_date_sets_it() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    let cookie = app.cookie_for(fx.owner).await;
    let (status, body) = set_role(
        &app,
        fx.space,
        fx.member,
        &cookie,
        json!({ "role": "guest", "expires_at": super::guest_expiry_routes_tests::rfc(OffsetDateTime::now_utc() + time::Duration::days(30)) }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let after = row(&app, fx.space, fx.member).await;
    assert_eq!(after.role, "guest");
    assert!(after.expires_at.is_some());
}

#[tokio::test]
async fn the_owner_cannot_be_made_a_guest() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    for who in [fx.admin, fx.owner] {
        let (status, _) = set_role(
            &app,
            fx.space,
            fx.owner,
            &app.cookie_for(who).await,
            json!({ "role": "guest" }),
        )
        .await;
        assert_eq!(status, 403);
    }
    assert_eq!(row(&app, fx.space, fx.owner).await.role, "owner");
}

#[tokio::test]
async fn rank_rules_still_apply() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    let second = make_user(&app.db, "second").await;
    crate::testkit::add_member(&app.db, fx.space, second, "admin").await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let admin_cookie = app.cookie_for(fx.admin).await;
    // An administrator cannot make another administrator a guest, nor a guest an administrator.
    let (status, body) = set_role(
        &app,
        fx.space,
        second,
        &admin_cookie,
        json!({ "role": "guest" }),
    )
    .await;
    assert_eq!(
        (status, &body["reason"]),
        (403, &json!("person_above_you")),
        "{body}"
    );
    let (status, _) = set_role(
        &app,
        fx.space,
        guest,
        &admin_cookie,
        json!({ "role": "admin" }),
    )
    .await;
    assert_eq!(status, 403);
    // A plain member cannot change anyone's standing.
    let (status, _) = set_role(
        &app,
        fx.space,
        guest,
        &app.cookie_for(fx.member).await,
        json!({ "role": "member" }),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(row(&app, fx.space, guest).await.role, "guest");
    assert_eq!(row(&app, fx.space, second).await.role, "admin");
}

#[tokio::test]
async fn standing_change_is_logged_and_announced() {
    let Some(app) = boot_seats(10).await else {
        return;
    };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let cookie = app.cookie_for(fx.owner).await;
    let mut ws = app.connect_ws(&app.cookie_for(fx.admin).await).await;
    frames(&mut ws).await;
    let changed = |seen: &[String]| seen.iter().filter(|k| *k == "permissions.changed").count();

    set_role(&app, fx.space, guest, &cookie, json!({ "role": "member" })).await;
    assert_eq!(changed(&frames(&mut ws).await), 1);
    set_role(&app, fx.space, guest, &cookie, json!({ "role": "guest" })).await;
    assert_eq!(changed(&frames(&mut ws).await), 1);
    // A change inside the members (member to administrator) is no change of standing.
    set_role(
        &app,
        fx.space,
        fx.member,
        &cookie,
        json!({ "role": "admin" }),
    )
    .await;
    assert_eq!(changed(&frames(&mut ws).await), 1);

    let standing = audit(&app, fx.space, "member.standing_changed").await;
    assert_eq!(standing.len(), 2, "{standing:?}");
    assert_eq!(standing[0]["before"], "guest");
    assert_eq!(standing[0]["after"], "member");
    assert_eq!(standing[1]["before"], "member");
    assert_eq!(standing[1]["after"], "guest");
    assert_eq!(audit(&app, fx.space, "member.role_changed").await.len(), 3);
}
