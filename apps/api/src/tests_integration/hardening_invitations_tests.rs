//! An invitation is honoured only while whoever issued it could still issue it, by the rules that
//! let them issue it; and the writes that decide on a space's people are re-decided under its lock.

use super::delegation_tests::{assign, make_role};
use super::groups_tests::{count, give_role_to_group, make_group, put_in_group};
use super::*;

use sea_orm::TransactionTrait;

/// An invitation row with a chosen role and group, returning the raw token.
async fn insert_invitation(
    db: &DatabaseConnection,
    space: Uuid,
    by: Uuid,
    email: Option<&str>,
    role: &str,
    channel: Option<Uuid>,
) -> String {
    let token = crate::auth::tokens::generate_token().expect("token");
    space_invitations::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(space),
        token_hash: Set(crate::auth::tokens::digest(&token)),
        email: Set(email.map(str::to_owned)),
        role: Set(role.to_owned()),
        created_by: Set(Some(by)),
        max_uses: Set(None),
        uses: Set(0),
        expires_at: Set(None),
        revoked_at: Set(None),
        channel_id: Set(channel),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("invitation");
    token
}

async fn accept_status(app: &TestApp, token: &str, cookie: &str) -> u16 {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/invitations/{token}/accept"),
        cookie,
    )
    .send()
    .await
    .expect("accept")
    .status()
    .as_u16()
}

async fn uses_of(app: &TestApp, token: &str) -> i32 {
    space_invitations::Entity::find()
        .filter(space_invitations::Column::TokenHash.eq(crate::auth::tokens::digest(token)))
        .one(&app.db)
        .await
        .expect("query")
        .expect("invitation")
        .uses
}

/// Hold the space's row lock from the test: whatever is sent next queues behind it, in the order
/// it was sent, so a race is replayed in the order a test chooses.
async fn hold_space_row(app: &TestApp, space: Uuid) -> sea_orm::DatabaseTransaction {
    let txn = app.db.begin().await.expect("begin");
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE",
        [space.into()],
    ))
    .await
    .expect("space lock");
    txn
}

async fn pause() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

#[tokio::test]
async fn a_member_invitation_survives_an_issuer_whose_right_comes_from_a_custom_role_or_a_group() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Redeem").await;
    // Both sit at the members' own position: their rank does not outrank the member role, which is
    // not what creating a member invitation asked.
    let direct = make_user(&app.db, "direct").await;
    crate::testkit::add_member(&app.db, space, direct, "member").await;
    let role = make_role(&app.db, space, "Accueil", 0, &["members.invite"]).await;
    assign(&app.db, space, direct, role).await;
    let carried = make_user(&app.db, "carried").await;
    crate::testkit::add_member(&app.db, space, carried, "member").await;
    let group = make_group(&app.db, space, "Accueil").await;
    give_role_to_group(&app.db, group, space, role)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, carried, false).await;

    for (name, issuer) in [("direct", direct), ("carried", carried)] {
        let created = app
            .req(
                reqwest::Method::POST,
                &format!("/api/v1/spaces/{space}/invitations"),
                &app.cookie_for(issuer).await,
            )
            .json(&json!({ "role": "member" }))
            .send()
            .await
            .expect("create");
        assert_eq!(created.status(), 201, "{name} may create it");
        let created: Value = created.json().await.expect("json");
        let token = token_of(created["url"].as_str().expect("url"));
        let newcomer = make_user(&app.db, &format!("new-{name}")).await;
        assert_eq!(
            accept_status(&app, &token, &app.cookie_for(newcomer).await).await,
            200,
            "{name}: what they could issue is honoured"
        );
    }
}

#[tokio::test]
async fn an_administrator_invitation_from_a_demoted_owner_still_fails() {
    let Some(app) = boot().await else { return };
    let first = make_user(&app.db, "first").await;
    let space = crate::testkit::make_space(&app.db, first, "Demoted").await;
    let second = make_user(&app.db, "second").await;
    crate::testkit::add_member(&app.db, space, second, "owner").await;
    let token = insert_invitation(&app.db, space, first, None, "admin", None).await;
    let before = make_user(&app.db, "before").await;
    assert_eq!(
        accept_status(&app, &token, &app.cookie_for(before).await).await,
        200,
        "an owner may mint an administrator"
    );
    let token = insert_invitation(&app.db, space, first, None, "admin", None).await;
    set_space_role(&app.db, space, first, "admin").await;
    let after = make_user(&app.db, "after").await;
    assert_eq!(
        accept_status(&app, &token, &app.cookie_for(after).await).await,
        404,
        "once demoted, the same link mints nobody"
    );
}

/// A private group made by `fx.bob` (so run by him), and a link into it for `address`.
async fn group_link(app: &TestApp, fx: &Fixture, address: &str) -> (Uuid, String) {
    let bob = app.cookie_for(fx.bob).await;
    let group: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &bob,
        )
        .json(&json!({ "name": format!("ext-{}", Uuid::new_v4().simple()), "type": "private" }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let group_id: Uuid = group["id"].as_str().expect("id").parse().expect("uuid");
    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/channels/{group_id}/invitations"),
            &bob,
        )
        .json(&json!({ "email": address }))
        .send()
        .await
        .expect("invite")
        .json()
        .await
        .expect("json");
    (group_id, token_of(created["url"].as_str().expect("url")))
}

async fn email_of(app: &TestApp, user: Uuid) -> String {
    users::Entity::find_by_id(user)
        .one(&app.db)
        .await
        .expect("user")
        .expect("found")
        .email
}

#[tokio::test]
async fn an_existing_member_is_not_let_into_a_group_by_a_link_whose_issuer_is_gone() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let address = email_of(&app, fx.carol).await;
    let (group, token) = group_link(&app, &fx, &address).await;
    // The issuer leaves the space without the lists being settled (the row alone goes).
    exec_sql(
        &app,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![fx.space_id.into(), fx.bob.into()],
    )
    .await;
    assert_eq!(
        accept_status(&app, &token, &app.cookie_for(fx.carol).await).await,
        404
    );
    assert!(channel_members::Entity::find_by_id((group, fx.carol))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
    assert_eq!(uses_of(&app, &token).await, 0, "and no use is spent");
}

#[tokio::test]
async fn a_link_into_a_group_dies_with_the_issuers_right_on_that_group() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // One for a newcomer, one for somebody already in the space: both refuse.
    let outsider = make_user(&app.db, "outsider").await;
    let outsider_address = email_of(&app, outsider).await;
    let carol_address = email_of(&app, fx.carol).await;
    let (group_a, newcomer_token) = group_link(&app, &fx, &outsider_address).await;
    let (group_b, member_token) = group_link(&app, &fx, &carol_address).await;
    // The moderator (the group's owner here) is put back to a plain member of both groups.
    for group in [group_a, group_b] {
        exec_sql(
            &app,
            "UPDATE channel_members SET role = 'member' WHERE channel_id = $1 AND user_id = $2",
            vec![group.into(), fx.bob.into()],
        )
        .await;
    }
    assert_eq!(
        accept_status(&app, &newcomer_token, &app.cookie_for(outsider).await).await,
        404
    );
    assert!(space_members::Entity::find_by_id((fx.space_id, outsider))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
    assert_eq!(
        accept_status(&app, &member_token, &app.cookie_for(fx.carol).await).await,
        404
    );
    assert!(channel_members::Entity::find_by_id((group_b, fx.carol))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
    assert_eq!(uses_of(&app, &member_token).await, 0);
}

async fn exec_sql(app: &TestApp, sql: &str, values: Vec<sea_orm::Value>) {
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .expect("sql");
}

#[tokio::test]
async fn an_invitation_from_somebody_no_longer_entitled_proves_no_address() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Proof").await;
    let admin = make_user(&app.db, "admin").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let address = format!("proof-{}@example.test", Uuid::new_v4().simple());
    let token = insert_invitation(&app.db, space, admin, Some(&address), "member", None).await;
    exec_sql(
        &app,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), admin.into()],
    )
    .await;
    let registered = register(&app, &address, "Invitee", Some(&token)).await;
    assert_eq!(registered.status(), 201);
    let account: Value = registered.json().await.expect("json");
    assert_eq!(
        account["active"], false,
        "the address still has to be confirmed"
    );
}

#[tokio::test]
async fn removing_somebody_while_they_become_the_owner_leaves_the_space_an_owner() {
    let Some(app) = boot().await else { return };
    for round in 0..3 {
        let owner = make_user(&app.db, &format!("o{round}")).await;
        let space = crate::testkit::make_space(&app.db, owner, "Handover").await;
        let heir = make_user(&app.db, &format!("h{round}")).await;
        crate::testkit::add_member(&app.db, space, heir, "admin").await;
        let cookie = app.cookie_for(owner).await;
        let held = hold_space_row(&app, space).await;
        let transfer = app
            .req(
                reqwest::Method::PATCH,
                &format!("/api/v1/spaces/{space}/members/{heir}"),
                &cookie,
            )
            .json(&json!({ "role": "owner" }))
            .send();
        let transfer = tokio::spawn(async move { transfer.await.expect("send").status().as_u16() });
        pause().await;
        let removal = app
            .req(
                reqwest::Method::DELETE,
                &format!("/api/v1/spaces/{space}/members/{heir}"),
                &cookie,
            )
            .send();
        let removal = tokio::spawn(async move { removal.await.expect("send").status().as_u16() });
        pause().await;
        held.commit().await.expect("release");
        let (transfer, removal) = (transfer.await.expect("join"), removal.await.expect("join"));
        assert_eq!(transfer, 200, "round {round}");
        assert_eq!(
            removal, 403,
            "round {round}: the heir now outranks the sender"
        );
        let owners = count(
            &app.db,
            "SELECT count(*)::bigint AS n FROM space_members WHERE space_id = $1 AND role = 'owner'",
            vec![space.into()],
        )
        .await;
        assert_eq!(owners, 1, "round {round}");
    }
}

#[tokio::test]
async fn a_transfer_to_somebody_just_removed_answers_a_clean_404() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Gone").await;
    let heir = make_user(&app.db, "heir").await;
    crate::testkit::add_member(&app.db, space, heir, "admin").await;
    let cookie = app.cookie_for(owner).await;
    let held = hold_space_row(&app, space).await;
    let removal = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/members/{heir}"),
            &cookie,
        )
        .send();
    let removal = tokio::spawn(async move { removal.await.expect("send").status().as_u16() });
    pause().await;
    let transfer = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space}/members/{heir}"),
            &cookie,
        )
        .json(&json!({ "role": "owner" }))
        .send();
    let transfer = tokio::spawn(async move { transfer.await.expect("send").status().as_u16() });
    pause().await;
    held.commit().await.expect("release");
    assert_eq!(removal.await.expect("join"), 204);
    assert_eq!(transfer.await.expect("join"), 404);
}

#[tokio::test]
async fn two_identical_promotions_at_once_write_one_change_and_one_audit_line() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Twice").await;
    let guest = make_user(&app.db, "guest").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    let cookie = app.cookie_for(owner).await;
    let held = hold_space_row(&app, space).await;
    let mut sent = Vec::new();
    for _ in 0..2 {
        let request = app
            .req(
                reqwest::Method::PATCH,
                &format!("/api/v1/spaces/{space}/members/{guest}"),
                &cookie,
            )
            .json(&json!({ "role": "member" }))
            .send();
        sent.push(tokio::spawn(async move {
            let response = request.await.expect("send");
            let status = response.status().as_u16();
            (status, response.json::<Value>().await.expect("json"))
        }));
        pause().await;
    }
    held.commit().await.expect("release");
    let mut changed = 0;
    for task in sent {
        let (status, body) = task.await.expect("join");
        assert_eq!(status, 200);
        changed += body.as_array().map_or(0, Vec::len);
    }
    assert_eq!(changed, 1, "the second finds the role already given");
    let lines = count(
        &app.db,
        "SELECT count(*)::bigint AS n FROM space_audit_log WHERE space_id = $1 \
         AND action = 'member.role_changed'",
        vec![space.into()],
    )
    .await;
    assert_eq!(lines, 1);
}

#[tokio::test]
async fn leaving_with_invitations_outstanding_writes_one_line_for_them() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Bulk").await;
    let admin = make_user(&app.db, "admin").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let other = make_user(&app.db, "other").await;
    crate::testkit::add_member(&app.db, space, other, "admin").await;
    for _ in 0..2 {
        insert_invitation(&app.db, space, admin, None, "member", None).await;
    }
    let lines = |action: &'static str| {
        let app = &app;
        async move {
            count(
                &app.db,
                "SELECT count(*)::bigint AS n FROM space_audit_log WHERE space_id = $1 \
                 AND action = $2",
                vec![space.into(), action.into()],
            )
            .await
        }
    };
    // Nothing to revoke, nothing to say.
    let quiet = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/membership"),
            &app.cookie_for(other).await,
        )
        .send()
        .await
        .expect("leave");
    assert_eq!(quiet.status(), 204);
    assert_eq!(lines("member.issued_revoked").await, 0);
    // Removed by the owner: the two invitations are revoked, said once.
    let removed = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/members/{admin}"),
            &app.cookie_for(owner).await,
        )
        .send()
        .await
        .expect("remove");
    assert_eq!(removed.status(), 204);
    assert_eq!(lines("member.issued_revoked").await, 1);
    let details: Value = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT details FROM space_audit_log WHERE space_id = $1 AND action = 'member.issued_revoked'",
            [space.into()],
        ))
        .await
        .expect("query")
        .expect("line")
        .try_get("", "details")
        .expect("details");
    assert_eq!(details["invitations"], 2);
    assert_eq!(details["links"], 0);
}
