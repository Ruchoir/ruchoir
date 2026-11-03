//! Mentioning a group (`@Comptabilité`): its members who can read the conversation are told as if
//! they had been named, and nobody else is.

use super::groups_tests::{make_group, put_in_group};
use super::*;

async fn post(app: &TestApp, who: Uuid, conversation: Uuid, body: &str) -> reqwest::Response {
    let cookie = app.cookie_for(who).await;
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{conversation}/messages"),
        &cookie,
    )
    .json(&json!({ "body": body }))
    .send()
    .await
    .expect("send")
}

async fn kinds_of(app: &TestApp, user: Uuid) -> Vec<String> {
    notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(user))
        .all(&app.db)
        .await
        .expect("query")
        .into_iter()
        .map(|row| row.kind)
        .collect()
}

async fn stored_types(app: &TestApp, user: Uuid) -> Vec<String> {
    app.db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT mention_type FROM message_mentions WHERE mentioned_user_id = $1",
            [user.into()],
        ))
        .await
        .expect("mentions")
        .into_iter()
        .map(|row| row.try_get("", "mention_type").expect("type"))
        .collect()
}

#[tokio::test]
async fn a_group_mention_notifies_its_members_as_a_mention() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    let group = make_group(&app.db, fx.space_id, "Comptabilité").await;
    put_in_group(&app.db, group, fx.space_id, fx.alice, false).await;
    put_in_group(&app.db, group, fx.space_id, fx.carol, false).await;

    let sent = post(&app, fx.bob, fx.public_channel, "@comptabilite, un devis").await;
    assert_eq!(sent.status(), 201);

    for member in [fx.alice, fx.carol] {
        assert_eq!(kinds_of(&app, member).await, vec!["mention".to_owned()]);
        assert_eq!(stored_types(&app, member).await, vec!["group".to_owned()]);
    }
    assert!(kinds_of(&app, fx.bob).await.is_empty(), "never the author");
}

#[tokio::test]
async fn a_group_mention_reaches_only_its_members_in_the_room() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Equipe Compta").await;
    for user in [fx.alice, fx.bob, fx.carol] {
        put_in_group(&app.db, group, fx.space_id, user, false).await;
    }

    // Carol is not in the public channel: the group does not bring her in.
    let sent = post(&app, fx.alice, fx.public_channel, "@Equipe Compta bonjour").await;
    assert_eq!(sent.status(), 201);
    assert_eq!(kinds_of(&app, fx.bob).await, vec!["mention".to_owned()]);
    assert!(kinds_of(&app, fx.carol).await.is_empty());
    assert!(stored_types(&app, fx.carol).await.is_empty());

    // Nor in a direct conversation she is not part of.
    let dm: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/dm", fx.space_id),
            &app.cookie_for(fx.alice).await,
        )
        .json(&json!({ "user_ids": [fx.bob] }))
        .send()
        .await
        .expect("dm")
        .json()
        .await
        .expect("json");
    let dm_id: Uuid = dm["id"].as_str().expect("id").parse().expect("uuid");
    let sent = post(&app, fx.alice, dm_id, "@Equipe Compta en prive").await;
    assert_eq!(sent.status(), 201);
    assert!(kinds_of(&app, fx.carol).await.is_empty());
}

#[tokio::test]
async fn a_guest_cannot_mention_a_group() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    add_channel_member(&app.db, fx.private_channel, fx.carol).await;
    let group = make_group(&app.db, fx.space_id, "Comptabilité").await;
    put_in_group(&app.db, group, fx.space_id, fx.alice, false).await;

    let sent = post(&app, fx.carol, fx.private_channel, "@Comptabilité bonjour").await;
    assert_eq!(sent.status(), 201, "the message itself is fine");
    assert!(kinds_of(&app, fx.alice).await.is_empty());
    assert!(stored_types(&app, fx.alice).await.is_empty());
}

#[tokio::test]
async fn an_edit_that_adds_a_group_mention_notifies() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Comptabilité").await;
    put_in_group(&app.db, group, fx.space_id, fx.alice, false).await;

    let message_id = post_in_general(&app, &fx, fx.bob, "bonjour").await;
    assert!(kinds_of(&app, fx.alice).await.is_empty());
    let edited = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/messages/{message_id}"),
            &app.cookie_for(fx.bob).await,
        )
        .json(&json!({ "body": "@Comptabilité bonjour" }))
        .send()
        .await
        .expect("edit");
    assert_eq!(edited.status(), 200);
    assert_eq!(kinds_of(&app, fx.alice).await, vec!["mention".to_owned()]);
    assert_eq!(stored_types(&app, fx.alice).await, vec!["group".to_owned()]);
}

#[tokio::test]
async fn a_deleted_group_mentions_nobody() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Comptabilité").await;
    put_in_group(&app.db, group, fx.space_id, fx.alice, false).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM space_groups WHERE id = $1",
            [group.into()],
        ))
        .await
        .expect("delete");

    let sent = post(&app, fx.bob, fx.public_channel, "@Comptabilité bonjour").await;
    assert_eq!(sent.status(), 201);
    assert!(kinds_of(&app, fx.alice).await.is_empty());
}
