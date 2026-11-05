//! Regressions for the permissions hardening review: each test failed before its fix.

use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

async fn status(
    app: &TestApp,
    method: reqwest::Method,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> u16 {
    let mut request = app.req(method, path, cookie);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await.expect("request").status().as_u16()
}

/// A direct conversation between `people`, in `space`.
async fn dm_between(app: &TestApp, space: Uuid, people: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    for sql in [
        "INSERT INTO conversations (id, space_id, kind) VALUES ($1, $2, 'direct')",
        "INSERT INTO dm_conversations (id, space_id, is_group, created_by) \
         VALUES ($1, $2, false, NULL)",
    ] {
        exec(&app.db, sql, vec![id.into(), space.into()])
            .await
            .expect("dm");
    }
    for user in people {
        exec(
            &app.db,
            "INSERT INTO dm_participants (dm_id, user_id) VALUES ($1, $2)",
            vec![id.into(), (*user).into()],
        )
        .await
        .expect("participant");
    }
    id
}

// --- M1: a DM file is not read by someone who is no longer in the space ---

#[tokio::test]
async fn a_person_out_of_the_space_reads_no_file_of_their_old_direct_messages() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Dm files").await;
    let kept = make_user(&app.db, "kept").await;
    crate::testkit::add_member(&app.db, space, kept, "member").await;
    let leaver = make_user(&app.db, "leaver").await;
    crate::testkit::add_member(&app.db, space, leaver, "member").await;
    let guest = guest_ending(&app.db, space, "1 day").await;
    let dm_left = dm_between(&app, space, &[kept, leaver]).await;
    let dm_guest = dm_between(&app, space, &[kept, guest]).await;

    let mut files = Vec::new();
    for (dm, who) in [(dm_left, leaver), (dm_guest, guest)] {
        let file = Uuid::new_v4();
        exec(
            &app.db,
            "INSERT INTO files (id, space_id, owner_id, name, kind, conversation_id) \
             VALUES ($1, $2, $3, 'secret.pdf', 'file', $4)",
            vec![file.into(), space.into(), kept.into(), dm.into()],
        )
        .await
        .expect("file");
        files.push((file, who));
    }

    let probes = |file: Uuid| {
        vec![
            (
                reqwest::Method::GET,
                format!("/api/v1/files/{file}/versions"),
                None,
            ),
            (
                reqwest::Method::GET,
                format!("/api/v1/files/{file}/download"),
                None,
            ),
            (
                reqwest::Method::GET,
                format!("/api/v1/files/{file}/preview"),
                None,
            ),
            (
                reqwest::Method::GET,
                format!("/api/v1/files/{file}/thumbnail"),
                None,
            ),
            (
                reqwest::Method::PATCH,
                format!("/api/v1/files/{file}"),
                Some(json!({ "name": "mine.pdf" })),
            ),
        ]
    };

    // While they are in, the versions list answers (the file is theirs to read).
    for (file, who) in &files {
        let cookie = app.cookie_for(*who).await;
        let code = status(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/files/{file}/versions"),
            &cookie,
            None,
        )
        .await;
        assert_eq!(
            code, 200,
            "a participant still in the space reads the versions"
        );
    }

    // The member is removed, the guest's access ends.
    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), leaver.into()],
    )
    .await
    .expect("remove");
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() - interval '1 second' \
         WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), guest.into()],
    )
    .await
    .expect("end");

    for (file, who) in &files {
        let cookie = app.cookie_for(*who).await;
        for (method, path, body) in probes(*file) {
            let code = status(&app, method.clone(), &path, &cookie, body).await;
            assert!(
                code == 403 || code == 404,
                "{method} {path} answered {code} to someone out of the space"
            );
        }
    }
    // The name was not changed behind the refusal.
    let name: String = files::Entity::find_by_id(files[0].0)
        .one(&app.db)
        .await
        .expect("file")
        .expect("row")
        .name;
    assert_eq!(name, "secret.pdf");
    let kept_cookie = app.cookie_for(kept).await;
    assert_eq!(
        status(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/files/{}/versions", files[0].0),
            &kept_cookie,
            None
        )
        .await,
        200,
        "the person who stayed still reads it"
    );
}

// --- L6: a public link lives only as long as its creator's right to hand the file out ---

fn fresh_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())[..48].to_owned()
}

async fn link_row(app: &TestApp, space: Uuid, file: Uuid, creator: Uuid, token: &str) {
    exec(
        &app.db,
        "INSERT INTO file_links (id, file_id, space_id, token, created_by, created_at, download_count) \
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 0)",
        vec![file.into(), space.into(), token.into(), creator.into()],
    )
    .await
    .expect("link");
}

async fn public_status(app: &TestApp, token: &str) -> u16 {
    app.http
        .get(format!("{}/api/v1/public/links/{token}", app.base))
        .send()
        .await
        .expect("anonymous request")
        .status()
        .as_u16()
}

async fn file_of(app: &TestApp, space: Uuid, owner: Uuid, name: &str) -> Uuid {
    let file = Uuid::new_v4();
    exec(
        &app.db,
        "INSERT INTO files (id, space_id, owner_id, name, kind) VALUES ($1, $2, $3, $4, 'file')",
        vec![file.into(), space.into(), owner.into(), name.into()],
    )
    .await
    .expect("file");
    file
}

#[tokio::test]
async fn a_public_link_stops_working_when_its_creator_loses_the_right_to_make_it() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Links").await;
    let removed = make_user(&app.db, "removed").await;
    crate::testkit::add_member(&app.db, space, removed, "member").await;
    let demoted = make_user(&app.db, "demoted").await;
    crate::testkit::add_member(&app.db, space, demoted, "member").await;
    let kept = make_user(&app.db, "kept").await;
    crate::testkit::add_member(&app.db, space, kept, "member").await;
    let tokens = [
        (fresh_token(), removed),
        (fresh_token(), demoted),
        (fresh_token(), kept),
    ];
    for (token, creator) in &tokens {
        let file = file_of(&app, space, *creator, "plan.txt").await;
        link_row(&app, space, file, *creator, token).await;
        assert_eq!(public_status(&app, token).await, 200, "live to begin with");
    }

    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), removed.into()],
    )
    .await
    .expect("remove");
    // A guest never hands a file out.
    exec(
        &app.db,
        "UPDATE space_members SET role = 'guest' WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), demoted.into()],
    )
    .await
    .expect("demote");

    assert_eq!(
        public_status(&app, &tokens[0].0).await,
        404,
        "creator removed"
    );
    assert_eq!(
        public_status(&app, &tokens[1].0).await,
        404,
        "creator now a guest"
    );
    assert_eq!(
        public_status(&app, &tokens[2].0).await,
        200,
        "creator unchanged"
    );
}

#[tokio::test]
async fn removing_a_member_revokes_their_links_and_invitations() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Cleanup").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "admin").await;
    let file = file_of(&app, space, member, "plan.txt").await;
    let token = fresh_token();
    link_row(&app, space, file, member, &token).await;
    let invitation = Uuid::new_v4();
    exec(
        &app.db,
        "INSERT INTO space_invitations (id, space_id, token_hash, role, created_by, uses, created_at) \
         VALUES ($1, $2, 'h-' || $1::text, 'member', $3, 0, now())",
        vec![invitation.into(), space.into(), member.into()],
    )
    .await
    .expect("invitation");

    let cookie = app.cookie_for(owner).await;
    let code = status(
        &app,
        reqwest::Method::DELETE,
        &format!("/api/v1/spaces/{space}/members/{member}"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(code, 204);

    let revoked = |table: &'static str, id: Uuid| {
        let app = &app;
        async move {
            app.db
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    format!("SELECT (revoked_at IS NOT NULL) AS r FROM {table} WHERE id = $1"),
                    [id.into()],
                ))
                .await
                .expect("query")
                .expect("row")
                .try_get::<bool>("", "r")
                .expect("r")
        }
    };
    let link_id: Uuid = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM file_links WHERE token = $1",
            [token.clone().into()],
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get("", "id")
        .expect("id");
    assert!(revoked("file_links", link_id).await, "the link is revoked");
    assert!(
        revoked("space_invitations", invitation).await,
        "the invitation is revoked"
    );
}
