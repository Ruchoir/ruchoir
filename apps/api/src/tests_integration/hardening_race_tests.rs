//! Check-then-write races on ownership: two requests at once leave the space consistent.

use super::*;

use super::groups_tests::count;
use sea_orm::TransactionTrait;

async fn owners(app: &TestApp, space: Uuid) -> i64 {
    count(
        &app.db,
        "SELECT count(*)::bigint AS n FROM space_members WHERE space_id = $1 AND role = 'owner'",
        vec![space.into()],
    )
    .await
}

#[tokio::test]
async fn two_owners_leaving_at_once_leave_one_owner() {
    let Some(app) = boot().await else { return };
    for round in 0..4 {
        let first = make_user(&app.db, &format!("first{round}")).await;
        let space = crate::testkit::make_space(&app.db, first, "Race").await;
        let second = make_user(&app.db, &format!("second{round}")).await;
        crate::testkit::add_member(&app.db, space, second, "owner").await;
        let (cookie_a, cookie_b) = (app.cookie_for(first).await, app.cookie_for(second).await);
        let path = format!("/api/v1/spaces/{space}/membership");
        let send = |cookie: String| {
            let request = app.req(reqwest::Method::DELETE, &path, &cookie);
            async move { request.send().await.expect("leave").status().as_u16() }
        };
        let (a, b) = tokio::join!(send(cookie_a), send(cookie_b));
        let mut codes = [a, b];
        codes.sort_unstable();
        assert_eq!(
            codes,
            [204, 409],
            "round {round}: one leaves, one is told to hand over"
        );
        assert_eq!(owners(&app, space).await, 1, "round {round}");
    }
}

#[tokio::test]
async fn two_transfers_at_once_give_one_owner() {
    let Some(app) = boot().await else { return };
    for round in 0..4 {
        let owner = make_user(&app.db, &format!("owner{round}")).await;
        let space = crate::testkit::make_space(&app.db, owner, "Transfer").await;
        let b = make_user(&app.db, &format!("b{round}")).await;
        let c = make_user(&app.db, &format!("c{round}")).await;
        crate::testkit::add_member(&app.db, space, b, "admin").await;
        crate::testkit::add_member(&app.db, space, c, "admin").await;
        let cookie = app.cookie_for(owner).await;
        let send = |target: Uuid| {
            let request = app
                .req(
                    reqwest::Method::PATCH,
                    &format!("/api/v1/spaces/{space}/members/{target}"),
                    &cookie,
                )
                .json(&json!({ "role": "owner" }));
            async move { request.send().await.expect("transfer").status().as_u16() }
        };
        let (x, y) = tokio::join!(send(b), send(c));
        let mut codes = [x, y];
        codes.sort_unstable();
        assert_eq!(codes[0], 200, "round {round}");
        assert!(
            codes[1] == 403,
            "round {round}: the second transfer is refused, got {codes:?}"
        );
        assert_eq!(owners(&app, space).await, 1, "round {round}");
    }
}

/// Hold the space's seat lock from the test, so two requests queue behind it in a chosen order
/// instead of racing: the interleaving a deadlock needs is then the one that always happens.
async fn hold_seat_lock(app: &TestApp, space: Uuid) -> sea_orm::DatabaseTransaction {
    let txn = app.db.begin().await.expect("begin");
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [space.to_string().into()],
    ))
    .await
    .expect("seat lock");
    txn
}

#[tokio::test]
async fn a_promotion_and_an_acceptance_in_one_space_deadlock_nobody() {
    let Some(app) = boot().await else { return };
    for round in 0..3 {
        let owner = make_user(&app.db, &format!("lockowner{round}")).await;
        let space = crate::testkit::make_space(&app.db, owner, "Locks").await;
        let guest = make_user(&app.db, &format!("lockguest{round}")).await;
        crate::testkit::add_member(&app.db, space, guest, "guest").await;
        let newcomer = make_user(&app.db, &format!("newcomer{round}")).await;
        let token = make_invitation(&app.db, space, owner, None).await;
        let (owner_cookie, newcomer_cookie) =
            (app.cookie_for(owner).await, app.cookie_for(newcomer).await);

        let held = hold_seat_lock(&app, space).await;
        let accept = app
            .req(
                reqwest::Method::POST,
                &format!("/api/v1/invitations/{token}/accept"),
                &newcomer_cookie,
            )
            .send();
        let accept = tokio::spawn(async move { accept.await.expect("accept").status().as_u16() });
        tokio::time::sleep(Duration::from_millis(400)).await;
        let promote = app
            .req(
                reqwest::Method::PATCH,
                &format!("/api/v1/spaces/{space}/members/{guest}"),
                &owner_cookie,
            )
            .json(&json!({ "role": "member" }))
            .send();
        let promote =
            tokio::spawn(async move { promote.await.expect("promote").status().as_u16() });
        tokio::time::sleep(Duration::from_millis(400)).await;
        held.commit().await.expect("release");

        let (accepted, promoted) = (accept.await.expect("join"), promote.await.expect("join"));
        assert_eq!(accepted, 200, "round {round}: the acceptance");
        assert_eq!(promoted, 200, "round {round}: the promotion");
    }
}
