//! Guests' end dates against a real database: the new columns and checks, the standing trigger,
//! the two notice kinds, and the one definition of an active membership (`permissions::membership`)
//! agreeing with the permission engine to the second.

use super::*;

use crate::permissions::membership;

pub(super) async fn exec(
    db: &DatabaseConnection,
    sql: &str,
    values: Vec<sea_orm::Value>,
) -> Result<(), String> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A guest ending `interval` from now (negative: ago), in a space owned by someone else.
pub(super) async fn guest_ending(db: &DatabaseConnection, space: Uuid, interval: &str) -> Uuid {
    let guest = make_user(db, "guest").await;
    crate::testkit::add_member(db, space, guest, "guest").await;
    exec(
        db,
        &format!(
            "UPDATE space_members SET expires_at = now() + interval '{interval}' \
             WHERE space_id = $1 AND user_id = $2"
        ),
        vec![space.into(), guest.into()],
    )
    .await
    .expect("set the end");
    guest
}

#[tokio::test]
async fn expiry_stage_is_guests_only() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Stage").await;
    let guest = make_user(&app.db, "guest").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;

    for stage in [7, 1, 0] {
        exec(
            &app.db,
            "UPDATE space_members SET expiry_stage = $3 WHERE space_id = $1 AND user_id = $2",
            vec![space.into(), guest.into(), (stage as i16).into()],
        )
        .await
        .unwrap_or_else(|e| panic!("stage {stage}: {e}"));
    }
    let odd = exec(
        &app.db,
        "UPDATE space_members SET expiry_stage = 3 WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), guest.into()],
    )
    .await;
    assert!(odd.is_err(), "only 0, 1 and 7 are stages");

    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let on_member = exec(
        &app.db,
        "UPDATE space_members SET expiry_stage = 7 WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), member.into()],
    )
    .await;
    assert!(on_member.is_err(), "a member has no stage");
}

#[tokio::test]
async fn a_member_cannot_carry_a_guest_end_on_an_invitation() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Invites").await;
    let salt = Uuid::new_v4();
    let insert =
        "INSERT INTO space_invitations (id, space_id, token_hash, role, guest_expires_at) \
                  VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '1 day')";
    let bad = exec(
        &app.db,
        insert,
        vec![
            space.into(),
            format!("h-member-{salt}").into(),
            "member".into(),
        ],
    )
    .await;
    assert!(bad.is_err(), "a member invitation has no guest end");
    exec(
        &app.db,
        insert,
        vec![
            space.into(),
            format!("h-guest-{salt}").into(),
            "guest".into(),
        ],
    )
    .await
    .expect("a guest invitation may carry one");
}

#[tokio::test]
async fn the_two_notice_kinds_are_accepted_and_others_still_refused() {
    let Some(app) = boot().await else { return };
    let user = make_user(&app.db, "someone").await;
    for kind in ["guest_expiry_soon", "guest_access_ending"] {
        exec(
            &app.db,
            "INSERT INTO notifications (id, user_id, kind, payload) \
             VALUES (gen_random_uuid(), $1, $2, '{\"days\": 7}'::jsonb)",
            vec![user.into(), kind.into()],
        )
        .await
        .unwrap_or_else(|e| panic!("{kind}: {e}"));
    }
    let no_payload = exec(
        &app.db,
        "INSERT INTO notifications (id, user_id, kind) \
         VALUES (gen_random_uuid(), $1, 'guest_expiry_soon')",
        vec![user.into()],
    )
    .await;
    assert!(no_payload.is_err(), "a guest notice needs its payload");
    let unknown = exec(
        &app.db,
        "INSERT INTO notifications (id, user_id, kind, payload) \
         VALUES (gen_random_uuid(), $1, 'guest_nonsense', '{}'::jsonb)",
        vec![user.into()],
    )
    .await;
    assert!(unknown.is_err(), "an unknown kind is still refused");
    let message_without_conversation = exec(
        &app.db,
        "INSERT INTO notifications (id, user_id, kind) \
         VALUES (gen_random_uuid(), $1, 'mention')",
        vec![user.into()],
    )
    .await;
    assert!(
        message_without_conversation.is_err(),
        "a message notice still needs its conversation"
    );
}

#[tokio::test]
async fn making_a_guest_a_member_clears_the_stage() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Promote").await;
    let guest = guest_ending(&app.db, space, "3 days").await;
    exec(
        &app.db,
        "UPDATE space_members SET expiry_stage = 7, expiry_notice_sent_at = now() \
         WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), guest.into()],
    )
    .await
    .expect("stage");
    exec(
        &app.db,
        "UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), guest.into()],
    )
    .await
    .expect("promote");
    let row = membership::active(&app.db, space, guest)
        .await
        .expect("read")
        .expect("still in");
    assert_eq!(row.standing, "member");
    assert_eq!(row.expires_at, None);
    assert_eq!(row.expiry_notice_sent_at, None);
    assert_eq!(row.expiry_stage, None);
}

#[tokio::test]
async fn active_matches_the_engine_at_the_boundary() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Boundary").await;
    let past = guest_ending(&app.db, space, "-1 second").await;
    // Written before the read, so already behind the database's clock when it is compared.
    let now = guest_ending(&app.db, space, "0 seconds").await;
    let future = guest_ending(&app.db, space, "1 hour").await;
    let just_ahead = guest_ending(&app.db, space, "1 second").await;
    let never = make_user(&app.db, "never").await;
    crate::testkit::add_member(&app.db, space, never, "guest").await;

    for (user, expected) in [
        (past, false),
        (now, false),
        (just_ahead, true),
        (future, true),
        (never, true),
    ] {
        let by_membership = membership::active(&app.db, space, user)
            .await
            .expect("active")
            .is_some();
        let by_engine = crate::permissions::check::standing(&app.db, space, user)
            .await
            .expect("standing")
            .is_some();
        assert_eq!(by_membership, expected, "membership for {user}");
        assert_eq!(by_engine, expected, "engine for {user}");
    }
    // The owner never expires.
    assert!(membership::active(&app.db, space, owner)
        .await
        .expect("owner")
        .is_some());
}

#[tokio::test]
async fn ended_lists_only_expired_guests() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Ended").await;
    let gone = guest_ending(&app.db, space, "-2 days").await;
    let recent = guest_ending(&app.db, space, "-1 hour").await;
    let coming = guest_ending(&app.db, space, "2 days").await;
    let open = make_user(&app.db, "open").await;
    crate::testkit::add_member(&app.db, space, open, "guest").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;

    let ended: Vec<Uuid> = membership::ended(&app.db, space)
        .await
        .expect("ended")
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    assert_eq!(ended, vec![gone, recent], "oldest end first, nobody else");

    let mut active = membership::active_ids(&app.db, space).await.expect("ids");
    active.sort();
    let mut expected = vec![owner, coming, open, member];
    expected.sort();
    assert_eq!(active, expected);

    assert_eq!(
        membership::spaces_of(&app.db, gone).await.expect("spaces"),
        Vec::<Uuid>::new()
    );
    assert_eq!(
        membership::spaces_of(&app.db, coming)
            .await
            .expect("spaces"),
        vec![space]
    );

    let any = membership::any(&app.db, space, gone)
        .await
        .expect("any")
        .expect("row kept");
    assert!(any.ended);
    let any = membership::any(&app.db, space, coming)
        .await
        .expect("any")
        .expect("row");
    assert!(!any.ended);
    assert!(membership::any(&app.db, space, Uuid::new_v4())
        .await
        .expect("any")
        .is_none());
}

#[tokio::test]
async fn the_loader_still_reads_a_person_in_one_query() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Count").await;
    let guest = guest_ending(&app.db, space, "1 day").await;
    // Warm up: a first read may repair the space.
    crate::permissions::check::standing(&app.db, space, guest)
        .await
        .expect("warm");
    let before = crate::permissions::load::queries_issued(space);
    crate::permissions::check::standing(&app.db, space, guest)
        .await
        .expect("standing");
    assert_eq!(
        crate::permissions::load::queries_issued(space) - before,
        1,
        "the shared definition adds no query"
    );
}
