//! `dm.start` and `message.mention_all` are enforced by the API, not only hidden by the clients.

use super::guest_expiry_tests::exec;
use super::*;

async fn take_from_base_role(app: &TestApp, space: Uuid, key: &str, permission: &str) {
    exec(
        &app.db,
        "UPDATE space_roles SET permissions = array_remove(permissions, $3) \
          WHERE space_id = $1 AND system_key = $2",
        vec![space.into(), key.into(), permission.into()],
    )
    .await
    .expect("take the right away");
}

async fn open_dm(app: &TestApp, who: Uuid, space: Uuid, with: Uuid) -> u16 {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/spaces/{space}/dm"),
        &app.cookie_for(who).await,
    )
    .json(&json!({ "user_ids": [with] }))
    .send()
    .await
    .expect("dm")
    .status()
    .as_u16()
}

#[tokio::test]
async fn a_role_without_dm_start_opens_no_direct_message() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Dm start").await;
    let asker = make_user(&app.db, "asker").await;
    crate::testkit::add_member(&app.db, space, asker, "member").await;
    let admin = make_user(&app.db, "admin").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;

    let before = open_dm(&app, asker, space, owner).await;
    assert!(
        before == 200 || before == 201,
        "members may by default, got {before}"
    );

    // A licensed space can take it away from members.
    take_from_base_role(&app, space, "members", "dm.start").await;
    assert_eq!(
        open_dm(&app, asker, space, admin).await,
        403,
        "the member has lost it"
    );
    assert_ne!(
        open_dm(&app, owner, space, admin).await,
        403,
        "the owner keeps it"
    );
}

async fn mention_rows(app: &TestApp, conversation: Uuid, kind: &str) -> i64 {
    super::groups_tests::count(
        &app.db,
        "SELECT count(*)::bigint AS n FROM message_mentions mm \
           JOIN messages m ON m.id = mm.message_id \
          WHERE m.conversation_id = $1 AND mm.mention_type = $2",
        vec![conversation.into(), kind.into()],
    )
    .await
}

async fn say(app: &TestApp, who: Uuid, conversation: Uuid, text: &str) -> u16 {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{conversation}/messages"),
        &app.cookie_for(who).await,
    )
    .json(&json!({ "body": text }))
    .send()
    .await
    .expect("send")
    .status()
    .as_u16()
}

#[tokio::test]
async fn a_room_wide_mention_notifies_only_for_a_sender_who_holds_mention_all() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Mentions").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let reader = make_user(&app.db, "reader").await;
    crate::testkit::add_member(&app.db, space, reader, "member").await;
    let general: Uuid = spaces::Entity::find_by_id(space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    for user in [member, reader] {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role, notification_level, muted, favorite, joined_at) \
             VALUES ($1, $2, 'member', 'default', false, false, now()) ON CONFLICT DO NOTHING",
            vec![general.into(), user.into()],
        )
        .await
        .expect("joined");
    }

    // Held (the default): the whole room is notified.
    assert_eq!(say(&app, member, general, "@channel hello").await, 201);
    assert!(mention_rows(&app, general, "channel").await >= 2);

    // Taken away: the message goes out, the handle is plain text, nobody is paged by it.
    take_from_base_role(&app, space, "members", "message.mention_all").await;
    let before =
        mention_rows(&app, general, "channel").await + mention_rows(&app, general, "here").await;
    assert_eq!(
        say(&app, member, general, "@channel again, and @here").await,
        201
    );
    let after =
        mention_rows(&app, general, "channel").await + mention_rows(&app, general, "here").await;
    assert_eq!(after, before, "no room-wide notification was recorded");
    // Naming a person is not a room-wide mention and stays free.
    assert_eq!(say(&app, member, general, "hello @reader").await, 201);
    assert_eq!(mention_rows(&app, general, "user").await, 1);
    // The owner, who still holds it, is not affected.
    assert_eq!(
        say(&app, owner, general, "@channel from the owner").await,
        201
    );
    assert!(mention_rows(&app, general, "channel").await > before);
}

#[tokio::test]
async fn the_room_wide_right_is_enforced_whatever_language_the_handle_is_written_in() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Languages").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let reader = make_user(&app.db, "reader").await;
    crate::testkit::add_member(&app.db, space, reader, "member").await;
    let general: Uuid = spaces::Entity::find_by_id(space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    for user in [member, reader] {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role, notification_level, muted, favorite, joined_at) \
             VALUES ($1, $2, 'member', 'default', false, false, now()) ON CONFLICT DO NOTHING",
            vec![general.into(), user.into()],
        )
        .await
        .expect("joined");
    }
    let words = [
        ("@Kanal", "channel"),
        ("@hier", "here"),
        ("@aquí", "here"),
        ("@canale", "channel"),
        ("@qui", "here"),
        ("@Kanał", "channel"),
        ("@tutaj", "here"),
    ];
    // `here` reaches the people connected now: the reader is.
    crate::realtime::presence::heartbeat(&app.valkey, reader, 300).await;
    // Held: each word of each language is a room-wide mention, so the right below has something to
    // refuse (a word the server did not know would be a plain name and prove nothing).
    for (word, kind) in words {
        let before = mention_rows(&app, general, kind).await;
        assert_eq!(
            say(&app, owner, general, &format!("{word} bonjour")).await,
            201
        );
        assert!(
            mention_rows(&app, general, kind).await > before,
            "{word} notifies the room"
        );
    }
    // Taken away: none of them records anything for a member.
    take_from_base_role(&app, space, "members", "message.mention_all").await;
    let total = |kind: &'static str| {
        let app = &app;
        async move { mention_rows(app, general, kind).await }
    };
    let before = total("channel").await + total("here").await;
    for (word, _) in words {
        assert_eq!(
            say(&app, member, general, &format!("{word} encore")).await,
            201
        );
    }
    assert_eq!(total("channel").await + total("here").await, before);
}
