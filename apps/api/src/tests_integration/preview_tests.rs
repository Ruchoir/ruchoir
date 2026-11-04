//! "Voir en tant que": the read only preview of a space as a role, against a real server.
//! The paid routes that start it live elsewhere; these tests start it through the same door they
//! use (`permissions::preview::start`) and prove it cannot write, leak or outlive its request.

use super::*;

use fred::interfaces::KeysInterface;

use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};
use crate::permissions::preview::{self, PreviewState};

use super::delegation_tests::{assign, make_role};

async fn exec(db: &DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .expect(sql);
}

struct Fixture {
    app: TestApp,
    space: Uuid,
    general: Uuid,
    owner: Uuid,
    admin: Uuid,
    member: Uuid,
    /// A custom role that only lets people write.
    notes: Uuid,
}

/// A space whose members may not see files by default, an owner, an administrator, a member and a
/// small role. The administrator holds everything through the Administrator role.
async fn fixture() -> Option<Fixture> {
    let app = boot().await?;
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Preview").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    exec(
        &app.db,
        "UPDATE space_roles SET permissions = array_remove(permissions, 'files.view') \
         WHERE space_id = $1 AND system_key = 'members'",
        vec![space.into()],
    )
    .await;
    let notes = make_role(&app.db, space, "Notes", 1, &["message.send"]).await;
    let general: Uuid = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT default_channel_id AS id FROM spaces WHERE id = $1",
            [space.into()],
        ))
        .await
        .expect("query")
        .expect("space")
        .try_get("", "id")
        .expect("id");
    for who in [admin, member] {
        super::permissions_tests::join_as(&app.db, general, who, "member").await;
    }
    Some(Fixture {
        app,
        space,
        general,
        owner,
        admin,
        member,
        notes,
    })
}

/// The id inside a `cookie_for` value.
fn session_of(cookie: &str) -> &str {
    cookie
        .strip_prefix(&format!("{SESSION_COOKIE}="))
        .expect("a session cookie")
}

/// A fresh session of `who` that is previewing `role` in `space`.
async fn previewing(fx: &Fixture, who: Uuid, space: Uuid, role: Uuid, name: &str) -> String {
    let cookie = fx.app.cookie_for(who).await;
    preview::start(
        &fx.app.valkey,
        &fx.app.config,
        session_of(&cookie),
        &PreviewState {
            space_id: space,
            role_id: role,
            role_name: name.to_owned(),
            user_id: who,
        },
    )
    .await
    .expect("start");
    cookie
}

async fn spaces_of(app: &TestApp, cookie: &str) -> Vec<Value> {
    let response = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", cookie)
        .send()
        .await
        .expect("spaces");
    assert_eq!(response.status().as_u16(), 200);
    response.json().await.expect("json")
}

fn entry(spaces: &[Value], space: Uuid) -> &Value {
    spaces
        .iter()
        .find(|s| s["id"] == space.to_string())
        .expect("the space")
}

fn held(entry: &Value) -> Vec<String> {
    entry["my_permissions"]
        .as_array()
        .expect("my_permissions")
        .iter()
        .map(|p| p.as_str().expect("name").to_owned())
        .collect()
}

async fn status_and_error(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (status, body["error"].as_str().unwrap_or("").to_owned())
}

#[tokio::test]
async fn a_preview_resolves_as_base_plus_the_role() {
    let Some(fx) = fixture().await else { return };
    let real = fx.app.cookie_for(fx.admin).await;
    let as_notes = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;

    // The administrator really reads files and holds the whole catalogue.
    let spaces = spaces_of(&fx.app, &real).await;
    assert!(held(entry(&spaces, fx.space)).contains(&"files.view".to_owned()));
    let files = format!("/api/v1/spaces/{}/files", fx.space);
    let response = fx
        .app
        .req(reqwest::Method::GET, &files, &real)
        .send()
        .await
        .expect("files");
    assert_eq!(response.status().as_u16(), 200);

    // As Notes: the base role (no files) plus the role (writing), nothing of the Administrator role.
    let spaces = spaces_of(&fx.app, &as_notes).await;
    let held = held(entry(&spaces, fx.space));
    assert!(!held.contains(&"files.view".to_owned()));
    assert!(!held.contains(&"roles.manage".to_owned()));
    assert!(held.contains(&"message.send".to_owned()));
    assert!(held.contains(&"channel.view".to_owned()));
    let response = fx
        .app
        .req(reqwest::Method::GET, &files, &as_notes)
        .send()
        .await
        .expect("files");
    assert_eq!(response.status().as_u16(), 403, "the files screen is gone");
    // The sidebar still lists the channel the base role lets everyone see.
    let channels = format!("/api/v1/spaces/{}/channels", fx.space);
    let listed: Value = fx
        .app
        .req(reqwest::Method::GET, &channels, &as_notes)
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    assert!(listed
        .as_array()
        .expect("list")
        .iter()
        .any(|c| c["id"] == fx.general.to_string()));
}

#[tokio::test]
async fn a_preview_never_shows_more_than_the_viewer() {
    let Some(fx) = fixture().await else { return };
    let power = make_role(
        &fx.app.db,
        fx.space,
        "Power",
        2,
        &["members.invite", "audit.view"],
    )
    .await;
    // A private channel nobody joined, opened to the Power role by a rule.
    let private = make_channel(&fx.app.db, fx.space, "secret", "private").await;
    exec(
        &fx.app.db,
        "INSERT INTO permission_overrides (space_id, channel_id, role_id, allow, deny) \
         VALUES ($1, $2, $3, ARRAY['channel.view'], ARRAY[]::text[])",
        vec![fx.space.into(), private.into(), power.into()],
    )
    .await;

    // The control: somebody who really holds Power does see it, and may invite.
    let holder = make_user(&fx.app.db, "holder").await;
    crate::testkit::add_member(&fx.app.db, fx.space, holder, "member").await;
    assign(&fx.app.db, fx.space, holder, power).await;
    assert!(check::can(
        &fx.app.db,
        fx.space,
        holder,
        Resource::Channel(private),
        Permission::ChannelView
    )
    .await
    .expect("check"));

    // The member does not, and previewing Power gives them neither.
    let cookie = previewing(&fx, fx.member, fx.space, power, "Power").await;
    let spaces = spaces_of(&fx.app, &cookie).await;
    let held = held(entry(&spaces, fx.space));
    assert!(!held.contains(&"members.invite".to_owned()));
    assert!(!held.contains(&"audit.view".to_owned()));
    let listed: Value = fx
        .app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space),
            &cookie,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    assert!(
        !listed
            .as_array()
            .expect("list")
            .iter()
            .any(|c| c["id"] == private.to_string()),
        "unseen stays unseen"
    );
    let state = PreviewState {
        space_id: fx.space,
        role_id: power,
        role_name: "Power".to_owned(),
        user_id: fx.member,
    };
    let can = preview::within(state, async {
        check::can(
            &fx.app.db,
            fx.space,
            fx.member,
            Resource::Channel(private),
            Permission::ChannelView,
        )
        .await
        .expect("check")
    })
    .await;
    assert!(!can);
}

#[tokio::test]
async fn a_preview_refuses_every_write() {
    let Some(fx) = fixture().await else { return };
    let real = fx.app.cookie_for(fx.admin).await;
    let message = format!("/api/v1/conversations/{}/messages", fx.general);
    let post = |cookie: &str| {
        fx.app
            .req(reqwest::Method::POST, &message, cookie)
            .json(&json!({ "body": "hello" }))
            .send()
    };
    // The control: the same write goes through without a preview.
    assert_eq!(post(&real).await.expect("post").status().as_u16(), 201);
    let count = |db: &DatabaseConnection| {
        let db = db.clone();
        async move {
            messages::Entity::find()
                .count(&db)
                .await
                .expect("count messages")
        }
    };
    let before = count(&fx.app.db).await;

    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;
    let space = fx.space;
    let other = Uuid::new_v4();
    let writes: Vec<(reqwest::Method, String, Value)> = vec![
        (reqwest::Method::POST, message.clone(), json!({"body": "x"})),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/channels/{}", fx.general),
            json!({"name": "renamed"}),
        ),
        (
            reqwest::Method::PUT,
            format!("/api/v1/spaces/{space}/access/channel/{}", fx.general),
            json!({"level": "read"}),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/spaces/{space}/access/channel/{}", fx.general),
            Value::Null,
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/folders"),
            json!({"name": "f"}),
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/files/{other}"),
            json!({"name": "g"}),
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/calendars"),
            json!({"name": "c", "color": "sky"}),
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/spaces/{space}/members/{}", fx.member),
            json!({"role": "guest"}),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/spaces/{space}/members/{}", fx.member),
            Value::Null,
        ),
        (
            reqwest::Method::PUT,
            "/api/v1/me/presence".to_owned(),
            json!({"status": "away"}),
        ),
        // A route that does not exist is refused at the door too: nothing is looked up first.
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/nothing-here"),
            Value::Null,
        ),
    ];
    for (method, path, body) in writes {
        let mut request = fx.app.req(method.clone(), &path, &cookie);
        if !body.is_null() {
            request = request.json(&body);
        }
        let (status, error) = status_and_error(request.send().await.expect("write")).await;
        assert_eq!(
            (status, error.as_str()),
            (403, "preview_read_only"),
            "{method} {path}"
        );
    }
    assert_eq!(count(&fx.app.db).await, before, "nothing was written");

    // Reading is fine, and so is leaving (the route is the paid crate's: here it must only get past the door).
    assert_eq!(spaces_of(&fx.app, &cookie).await.len(), 1);
    let leave = fx
        .app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/preview"),
            &cookie,
        )
        .send()
        .await
        .expect("leave");
    assert_ne!(leave.status().as_u16(), 403, "it gets past the door");

    // Signing out is allowed, and it ends the preview with the session.
    let out = fx
        .app
        .req(reqwest::Method::POST, "/api/v1/auth/logout", &cookie)
        .send()
        .await
        .expect("logout");
    assert_eq!(out.status().as_u16(), 204);
    assert!(preview::current(&fx.app.valkey, session_of(&cookie))
        .await
        .expect("current")
        .is_none());
}

#[tokio::test]
async fn a_preview_session_gets_no_realtime() {
    let Some(fx) = fixture().await else { return };
    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;

    let mut request = fx
        .app
        .ws_url
        .as_str()
        .into_client_request()
        .expect("ws request");
    request
        .headers_mut()
        .insert("cookie", cookie.parse().expect("cookie header"));
    match tokio_tungstenite::connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 403);
        }
        other => panic!("the socket should be refused, got {other:?}"),
    }
    let sse = fx
        .app
        .req(reqwest::Method::GET, "/api/v1/realtime/sse", &cookie)
        .send()
        .await
        .expect("sse");
    let (status, error) = status_and_error(sse).await;
    assert_eq!((status, error.as_str()), (403, "preview_read_only"));

    // Another session of the same person is not affected.
    let plain = fx.app.cookie_for(fx.admin).await;
    let _ws = fx.app.connect_ws(&plain).await;
    let sse = fx
        .app
        .req(reqwest::Method::GET, "/api/v1/realtime/sse", &plain)
        .send()
        .await
        .expect("sse");
    assert_eq!(sse.status().as_u16(), 200);
}

#[tokio::test]
async fn a_preview_is_the_sessions_and_the_spaces_only() {
    let Some(fx) = fixture().await else { return };
    let elsewhere = crate::testkit::make_space(&fx.app.db, fx.owner, "Elsewhere").await;
    crate::testkit::add_member(&fx.app.db, elsewhere, fx.admin, "admin").await;
    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;

    // The same session, another space: real rights, no preview.
    let spaces = spaces_of(&fx.app, &cookie).await;
    assert!(!held(entry(&spaces, fx.space)).contains(&"files.view".to_owned()));
    assert!(entry(&spaces, fx.space)["preview"].is_object());
    assert!(held(entry(&spaces, elsewhere)).contains(&"files.view".to_owned()));
    assert!(entry(&spaces, elsewhere)["preview"].is_null());

    // Another session of the same person: real rights everywhere.
    let other = fx.app.cookie_for(fx.admin).await;
    let spaces = spaces_of(&fx.app, &other).await;
    assert!(held(entry(&spaces, fx.space)).contains(&"files.view".to_owned()));
    assert!(entry(&spaces, fx.space)["preview"].is_null());
    let write = fx
        .app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.general),
            &other,
        )
        .json(&json!({ "body": "still allowed" }))
        .send()
        .await
        .expect("post");
    assert_eq!(write.status().as_u16(), 201);

    // The other people of the space are untouched too.
    let state = PreviewState {
        space_id: fx.space,
        role_id: fx.notes,
        role_name: "Notes".to_owned(),
        user_id: fx.admin,
    };
    let owner_rights = preview::within(state, async {
        check::space_rights(&fx.app.db, fx.space, fx.owner)
            .await
            .expect("rights")
    })
    .await;
    assert!(owner_rights.contains(Permission::SpaceSettings));
}

#[tokio::test]
async fn an_idle_preview_ends() {
    let Some(fx) = fixture().await else { return };
    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;
    let key = format!("preview:{}", session_of(&cookie));
    let ttl: i64 = fx.app.valkey.pttl(key.as_str()).await.expect("pttl");
    assert!(
        ttl > 1_790_000 && ttl <= 1_800_000,
        "thirty minutes, got {ttl}"
    );

    // Thirty minutes of silence, brought forward.
    let _: () = fx
        .app
        .valkey
        .pexpire(key.as_str(), 300, None)
        .await
        .expect("pexpire");
    tokio::time::sleep(Duration::from_millis(600)).await;
    let spaces = spaces_of(&fx.app, &cookie).await;
    assert!(held(entry(&spaces, fx.space)).contains(&"files.view".to_owned()));
    assert!(entry(&spaces, fx.space)["preview"].is_null());
    let write = fx
        .app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.general),
            &cookie,
        )
        .json(&json!({ "body": "back to normal" }))
        .send()
        .await
        .expect("post");
    assert_eq!(write.status().as_u16(), 201);
}

#[tokio::test]
async fn a_request_refreshes_the_idle_timer_but_a_heartbeat_does_not() {
    let Some(fx) = fixture().await else { return };
    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;
    let key = format!("preview:{}", session_of(&cookie));
    let shorten = || async {
        let _: () = fx
            .app
            .valkey
            .pexpire(key.as_str(), 60_000, None)
            .await
            .expect("pexpire");
    };
    let ttl = || async {
        let ttl: i64 = fx.app.valkey.pttl(key.as_str()).await.expect("pttl");
        ttl
    };

    // A page polling presence is nobody acting.
    shorten().await;
    let polled = fx
        .app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/presence", fx.space),
            &cookie,
        )
        .send()
        .await
        .expect("presence");
    assert_eq!(polled.status().as_u16(), 200);
    assert!(ttl().await <= 60_000, "a heartbeat leaves the timer alone");

    // A refused write is not activity either.
    let refused = fx
        .app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.general),
            &cookie,
        )
        .json(&json!({ "body": "x" }))
        .send()
        .await
        .expect("post");
    assert_eq!(refused.status().as_u16(), 403);
    assert!(ttl().await <= 60_000);

    // Opening a screen is.
    spaces_of(&fx.app, &cookie).await;
    assert!(
        ttl().await > 1_700_000,
        "a request pushes it back to thirty minutes"
    );
}

#[tokio::test]
async fn spawned_work_never_carries_the_preview() {
    let Some(fx) = fixture().await else { return };
    let state = PreviewState {
        space_id: fx.space,
        role_id: fx.notes,
        role_name: "Notes".to_owned(),
        user_id: fx.admin,
    };
    let (db, space, admin) = (fx.app.db.clone(), fx.space, fx.admin);
    let (inside, spawned) = preview::within(state, async move {
        let inside = check::space_rights(&db, space, admin).await.expect("in");
        let spawned_db = db.clone();
        let spawned = tokio::spawn(async move {
            check::space_rights(&spawned_db, space, admin)
                .await
                .expect("spawned")
        })
        .await
        .expect("join");
        (inside, spawned)
    })
    .await;
    assert!(!inside.contains(Permission::FilesView));
    assert!(spawned.contains(Permission::FilesView), "real rights");
    assert!(spawned.contains(Permission::RolesManage));
}

#[tokio::test]
async fn an_owner_previewing_a_role_is_a_member() {
    let Some(fx) = fixture().await else { return };
    let real = fx.app.cookie_for(fx.owner).await;
    let cookie = previewing(&fx, fx.owner, fx.space, fx.notes, "Notes").await;

    let spaces = spaces_of(&fx.app, &real).await;
    assert_eq!(entry(&spaces, fx.space)["role"], "owner");
    assert!(held(entry(&spaces, fx.space)).contains(&"space.settings".to_owned()));

    let spaces = spaces_of(&fx.app, &cookie).await;
    let seen = entry(&spaces, fx.space);
    assert_eq!(seen["role"], "member");
    let held = held(seen);
    assert!(!held.contains(&"space.settings".to_owned()));
    assert!(!held.contains(&"files.view".to_owned()));
    assert!(held.contains(&"message.send".to_owned()));
}

#[tokio::test]
async fn the_space_dto_says_it_is_previewing() {
    let Some(fx) = fixture().await else { return };
    let plain = fx.app.cookie_for(fx.admin).await;
    assert!(entry(&spaces_of(&fx.app, &plain).await, fx.space)["preview"].is_null());
    let cookie = previewing(&fx, fx.admin, fx.space, fx.notes, "Notes").await;
    let spaces = spaces_of(&fx.app, &cookie).await;
    assert_eq!(
        entry(&spaces, fx.space)["preview"],
        json!({ "role_id": fx.notes.to_string(), "role_name": "Notes" })
    );
}

/// Every right comes out of `resolved`: a second caller of the engine would be a door the preview
/// (and its ceiling) does not guard.
#[test]
fn resolve_has_one_caller() {
    fn sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &mut files);
    let is_call = |line: &str| {
        let mut rest = line;
        while let Some(at) = rest.find("resolve(") {
            let before = &rest[..at];
            let ok = before
                .chars()
                .next_back()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == ':' || c == '.'));
            if ok && !before.trim_end().ends_with("fn") {
                return true;
            }
            rest = &rest[at + 8..];
        }
        false
    };
    // Who imports the engine's `resolve`: the file that holds `resolved`, and nobody else.
    let mut importers = Vec::new();
    for file in files {
        let name = file.strip_prefix(&src).expect("under src").to_owned();
        let name = name.to_string_lossy().replace('\\', "/");
        if name.starts_with("tests_integration") || name == "permissions/engine.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&file).expect("read");
        let live = text.split("#[cfg(test)]").next().unwrap_or("");
        let mut rest = live;
        while let Some(at) = rest.find("engine::") {
            rest = &rest[at + 8..];
            let statement = rest.split(';').next().unwrap_or("");
            if statement
                .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .any(|word| word == "resolve")
            {
                importers.push(name.clone());
            }
        }
        // Reaching it by its path is no better.
        assert!(
            !live.contains("engine::resolve("),
            "{name} calls the engine by its path"
        );
    }
    importers.dedup();
    assert_eq!(importers, ["permissions/check.rs"]);
    // And inside check.rs, only the body of `resolved`.
    let check = std::fs::read_to_string(src.join("permissions/check.rs")).expect("check.rs");
    let live = check.split("#[cfg(test)]").next().expect("live code");
    let start = live.find("fn resolved(").expect("resolved");
    let body = &live[start..];
    let end = body.find("\n}\n").expect("end of resolved");
    let outside = format!("{}{}", &live[..start], &body[end..]);
    assert!(
        !outside.lines().any(is_call),
        "check.rs calls resolve outside resolved"
    );
    assert!(body[..end].lines().any(is_call), "resolved calls resolve");
}
