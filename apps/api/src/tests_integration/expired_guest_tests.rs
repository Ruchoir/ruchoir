//! An expired guest is gone from every path at once: the routes refuse them as they refuse a
//! stranger, and no pool, count or share reaches them. Same harness as the parent module.

use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

use crate::permissions::membership;

/// A space with its owner, a member, a guest whose access is still running, a guest whose access
/// ended a second ago, and a stranger who was never in it.
struct Fx {
    space: Uuid,
    general: Uuid,
    owner: Uuid,
    member: Uuid,
    active: Uuid,
    expired: Uuid,
    stranger: Uuid,
}

async fn fx(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Ended").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let active = guest_ending(&app.db, space, "1 day").await;
    let expired = guest_ending(&app.db, space, "-1 second").await;
    let stranger = make_user(&app.db, "stranger").await;
    let general: Uuid = spaces::Entity::find_by_id(space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    Fx {
        space,
        general,
        owner,
        member,
        active,
        expired,
        stranger,
    }
}

async fn call(
    app: &TestApp,
    method: reqwest::Method,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> (u16, String) {
    let mut request = app.req(method, path, cookie);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    (
        response.status().as_u16(),
        response.text().await.unwrap_or_default(),
    )
}

async fn get_json(app: &TestApp, path: &str, cookie: &str) -> (u16, Value) {
    let (status, text) = call(app, reqwest::Method::GET, path, cookie, None).await;
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn ids(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row[key].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn an_expired_guest_gets_403_on_every_space_route() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let expired = app.cookie_for(fx.expired).await;
    let stranger = app.cookie_for(fx.stranger).await;
    let space = fx.space;
    let me = fx.expired;

    use reqwest::Method as M;
    let routes: Vec<(M, String, Option<Value>)> = vec![
        (
            M::GET,
            format!("/api/v1/conversations/{}/messages", fx.general),
            None,
        ),
        (M::GET, format!("/api/v1/spaces/{space}/channels"), None),
        (M::GET, format!("/api/v1/spaces/{space}/members"), None),
        (M::GET, format!("/api/v1/spaces/{space}/dms"), None),
        (M::GET, format!("/api/v1/spaces/{space}/files"), None),
        (M::GET, format!("/api/v1/spaces/{space}/files/recent"), None),
        (M::GET, format!("/api/v1/spaces/{space}/presence"), None),
        (M::GET, format!("/api/v1/spaces/{space}/invitations"), None),
        (
            M::GET,
            format!("/api/v1/search?q=hello&space_id={space}"),
            None,
        ),
        (
            M::POST,
            format!("/api/v1/spaces/{space}/calendars"),
            Some(json!({ "name": "Mine", "color": "mint" })),
        ),
        (
            M::PATCH,
            format!("/api/v1/spaces/{space}/members/{me}"),
            Some(json!({ "role": "member" })),
        ),
    ];
    for (method, path, body) in routes {
        let (status, text) = call(&app, method.clone(), &path, &expired, body.clone()).await;
        let (stranger_status, stranger_text) = call(&app, method, &path, &stranger, body).await;
        let expected = if path.ends_with("/calendars") {
            404
        } else {
            403
        };
        assert_eq!(status, expected, "{path}: {text}");
        assert_eq!(
            (status, text),
            (stranger_status, stranger_text),
            "{path}: the same refusal as a stranger's"
        );
    }
}

#[tokio::test]
async fn an_expired_guest_is_absent_from_every_pool_and_count() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let member = app.cookie_for(fx.member).await;
    let expired = app.cookie_for(fx.expired).await;
    let expired_id = fx.expired.to_string();

    // list_my_spaces: their own list is empty, and the count of the others leaves them out.
    let (_, mine) = get_json(&app, "/api/v1/me/spaces", &expired).await;
    assert!(ids(&mine, "id").is_empty(), "no space for an expired guest");
    let (_, spaces) = get_json(&app, "/api/v1/me/spaces", &member).await;
    let row = spaces
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"] == fx.space.to_string()))
        .expect("the space");
    assert_eq!(row["members"], 3, "owner, member and the running guest");

    // The member list (and with it the mention and direct-message candidates).
    let (_, members) = get_json(
        &app,
        &format!("/api/v1/spaces/{}/members", fx.space),
        &member,
    )
    .await;
    let listed = ids(&members, "user_id");
    assert_eq!(listed.len(), 3);
    assert!(!listed.contains(&expired_id));
    assert!(listed.contains(&fx.active.to_string()));

    // Role counts.
    let (_, roles) = get_json(&app, &format!("/api/v1/spaces/{}/roles", fx.space), &owner).await;
    let holders = |key: &str| {
        roles
            .as_array()
            .expect("roles")
            .iter()
            .find(|r| r["system_key"] == key)
            .map(|r| r["holders"].clone())
            .expect("role")
    };
    assert_eq!(holders("guests"), 1, "only the running guest");
    assert_eq!(holders("members"), 2, "the owner and the member");

    // Group members and counts.
    let group = super::groups_tests::make_group(&app.db, fx.space, "Crew").await;
    for user in [fx.member, fx.active, fx.expired] {
        super::groups_tests::put_in_group(&app.db, group, fx.space, user, false).await;
    }
    let (_, groups) = get_json(&app, &format!("/api/v1/spaces/{}/groups", fx.space), &owner).await;
    let crew = groups
        .as_array()
        .expect("groups")
        .iter()
        .find(|g| g["name"] == "Crew")
        .expect("the crew group");
    let in_group: Vec<String> = crew["member_ids"]
        .as_array()
        .expect("members")
        .iter()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect();
    assert_eq!(in_group.len(), 2, "{crew}");
    assert!(!in_group.contains(&expired_id));
    let other = super::groups_tests::make_group(&app.db, fx.space, "Other").await;
    let (status, _) = call(
        &app,
        reqwest::Method::POST,
        &format!("/api/v1/spaces/{}/groups/{other}/members", fx.space),
        &owner,
        Some(json!({ "user_ids": [fx.expired] })),
    )
    .await;
    assert_ne!(status, 200, "an expired guest cannot be added to a group");

    // The calendar attendee pool of a personal calendar and free/busy.
    let (_, calendars) = get_json(&app, "/api/v1/calendars", &owner).await;
    let personal = calendars
        .as_array()
        .expect("calendars")
        .iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal calendar")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let (status, pool) = get_json(
        &app,
        &format!("/api/v1/calendars/{personal}/invitees?q="),
        &owner,
    )
    .await;
    assert_eq!(status, 200, "{pool}");
    let pooled = ids(&pool, "user_id");
    assert!(!pooled.contains(&expired_id), "{pool}");
    assert!(pooled.contains(&fx.active.to_string()), "{pool}");
    let busy = |user: Uuid| {
        call(
            &app,
            reqwest::Method::POST,
            "/api/v1/calendar/freebusy",
            &member,
            Some(
                json!({ "users": [user], "from": "2026-10-20T00:00:00Z", "to": "2026-10-21T00:00:00Z" }),
            ),
        )
    };
    assert_eq!(busy(fx.active).await.0, 200);
    assert_eq!(busy(fx.expired).await.0, 403, "not reachable any more");

    // shares_a_space, through the profile card, from both ends.
    let (status, _) = get_json(&app, &format!("/api/v1/users/{}", fx.active), &member).await;
    assert_eq!(status, 200);
    let (status, _) = get_json(&app, &format!("/api/v1/users/{}", fx.expired), &member).await;
    assert_eq!(status, 403);
    let (status, _) = get_json(&app, &format!("/api/v1/users/{}", fx.member), &expired).await;
    assert_eq!(status, 403);

    // Presence co-members and the snapshot's id list.
    let co = crate::messaging::authz::space_co_members(&app.db, fx.member)
        .await
        .expect("co-members");
    assert!(!co.contains(&fx.expired));
    assert!(co.contains(&fx.active));
    assert_eq!(
        crate::messaging::authz::space_co_members(&app.db, fx.expired)
            .await
            .expect("alone"),
        vec![fx.expired]
    );
    let ids = crate::messaging::authz::space_member_ids(&app.db, fx.space, fx.member)
        .await
        .expect("ids");
    assert!(!ids.contains(&fx.expired));
    assert_eq!(
        crate::messaging::authz::space_role(&app.db, fx.space, fx.expired)
            .await
            .expect("role"),
        None
    );

    // The invitation card counts the people in the space now.
    let _ = membership::count_active(&app.db, fx.space)
        .await
        .expect("count");
    assert_eq!(
        membership::count_active(&app.db, fx.space)
            .await
            .expect("count"),
        3
    );
}

#[tokio::test]
async fn an_expired_guest_cannot_reach_files_calendars_or_shares() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let expired = app.cookie_for(fx.expired).await;

    // A file in the space, shared straight to the expired guest and to the running one.
    let file = Uuid::new_v4();
    files::ActiveModel {
        id: Set(file),
        space_id: Set(fx.space),
        owner_id: Set(Some(fx.owner)),
        name: Set("plan.pdf".to_owned()),
        kind: Set("file".to_owned()),
        size_bytes: Set(12),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("file");
    for user in [fx.expired, fx.active] {
        exec(
            &app.db,
            "INSERT INTO file_shares (id, file_id, shared_by, target_user_id, permission) \
             VALUES (gen_random_uuid(), $1, $2, $3, 'edit')",
            vec![file.into(), fx.owner.into(), user.into()],
        )
        .await
        .expect("share");
    }
    let rename = |cookie: String| {
        let app = &app;
        async move {
            call(
                app,
                reqwest::Method::PATCH,
                &format!("/api/v1/files/{file}"),
                &cookie,
                Some(json!({ "name": "renamed.pdf" })),
            )
            .await
            .0
        }
    };
    let expired_status = rename(expired.clone()).await;
    assert!(
        expired_status == 403 || expired_status == 404,
        "the share to an ended guest is inert, got {expired_status}"
    );
    // Sharing again to the ended guest is refused as sharing to a stranger is.
    let (status, _) = call(
        &app,
        reqwest::Method::POST,
        &format!("/api/v1/files/{file}/shares"),
        &owner,
        Some(json!({ "target_user_id": fx.expired, "permission": "view" })),
    )
    .await;
    assert_eq!(status, 400);

    // A personal calendar of the owner, shared to both: the ended guest's share is not live.
    let (_, calendars) = get_json(&app, "/api/v1/calendars", &owner).await;
    let personal: Uuid = calendars
        .as_array()
        .expect("calendars")
        .iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal calendar")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    for user in [fx.expired, fx.active] {
        exec(
            &app.db,
            "INSERT INTO calendar_shares (calendar_id, user_id, level, created_by) \
             VALUES ($1, $2, 'read', $3)",
            vec![personal.into(), user.into(), fx.owner.into()],
        )
        .await
        .expect("calendar share");
    }
    let live: Vec<Uuid> = crate::calendar::authz::live_shares(&app.db, Some(personal), None)
        .await
        .expect("live")
        .into_iter()
        .map(|(_, user, _)| user)
        .collect();
    assert_eq!(live, vec![fx.active]);
    assert!(
        !crate::calendar::authz::share_a_space(&app.db, fx.owner, fx.expired)
            .await
            .expect("share a space")
    );
    let (_, theirs) = get_json(&app, "/api/v1/calendars", &expired).await;
    assert_eq!(
        ids(&theirs, "id"),
        ids(&theirs, "id")
            .into_iter()
            .filter(|id| *id != personal.to_string())
            .collect::<Vec<_>>(),
        "the owner's calendar is not among theirs"
    );
    assert!(
        theirs
            .as_array()
            .expect("calendars")
            .iter()
            .all(|c| c["space_id"] != fx.space.to_string()),
        "no calendar of the space either"
    );
}

#[tokio::test]
async fn an_expired_guest_cannot_leave() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let expired = app.cookie_for(fx.expired).await;
    let (status, _) = call(
        &app,
        reqwest::Method::DELETE,
        &format!("/api/v1/spaces/{}/membership", fx.space),
        &expired,
        None,
    )
    .await;
    assert_eq!(status, 403);
    // The row is still there: ending access is not leaving.
    assert!(membership::any(&app.db, fx.space, fx.expired)
        .await
        .expect("any")
        .is_some());
}

#[tokio::test]
async fn an_active_guest_and_a_member_are_unchanged() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let active = app.cookie_for(fx.active).await;
    let member = app.cookie_for(fx.member).await;
    let space = fx.space;
    let (status, body) = get_json(
        &app,
        &format!("/api/v1/conversations/{}/messages", fx.general),
        &member,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    for cookie in [&active, &member] {
        for path in [
            format!("/api/v1/spaces/{space}/channels"),
            format!("/api/v1/spaces/{space}/members"),
            format!("/api/v1/spaces/{space}/presence"),
            "/api/v1/me/spaces".to_owned(),
        ] {
            let (status, body) = get_json(&app, &path, cookie).await;
            assert_eq!(status, 200, "{path}: {body}");
        }
    }
    let (_, spaces) = get_json(&app, "/api/v1/me/spaces", &active).await;
    assert_eq!(ids(&spaces, "id"), vec![space.to_string()]);
    // The guest sees themselves and nobody they share no conversation with.
    let (_, seen) = get_json(&app, &format!("/api/v1/spaces/{space}/members"), &active).await;
    assert!(ids(&seen, "user_id").contains(&fx.active.to_string()));
    // Leaving still works for a running guest.
    let (status, _) = call(
        &app,
        reqwest::Method::DELETE,
        &format!("/api/v1/spaces/{space}/membership"),
        &active,
        None,
    )
    .await;
    assert_eq!(status, 204);
}

/// Every read of `space_members`, and every read of `channel_members` that decides an audience, a
/// count or a list, outside `permissions/membership.rs` is either filtered by the shared definition
/// of "active" in the same statement, or is on one of these lists with its file, function and reason.
/// A new read must go through `membership`, or be added here with its reason.
#[test]
fn no_bare_space_members_reads() {
    // (file, function): management screens and the rows the engine itself loads.
    const SPACE_MEMBERS: &[(&str, &str)] = &[
        // management: sees ended guests
        ("messaging/spaces.rs", "update_member_role"),
        ("messaging/spaces.rs", "remove_member"),
        ("messaging/spaces.rs", "leave_space"),
        // the sweep that closes and removes ended guests
        ("permissions/guest_expiry.rs", "remind"),
        ("permissions/guest_expiry.rs", "expire"),
        ("permissions/guest_expiry.rs", "purge"),
        // who invited a guest, read for the notice's contact; the person is then checked as a
        // manager through the engine
        ("permissions/guest_expiry.rs", "contact_of"),
        ("permissions/delegation.rs", "rank_of"),
        ("calendar/authz.rs", "create_space_default"),
        // the edition's seat count: guests are not counted
        ("edition.rs", "seats_used"),
        // writes and the import (a row there already blocks the insert)
        ("importer/routes.rs", "invite_one"),
        ("importer/run.rs", "import_conversations"),
    ];
    const CHANNEL_MEMBERS: &[(&str, &str)] = &[
        // the editor's own channel role, read only after `editor_of` found them in the space
        ("permissions/rules.rs", "resource_facts"),
        // filtered by the engine (`channel.view` among the members)
        ("messaging/authz.rs", "channel_audience"),
        // filtered by the active set right after
        ("messaging/authz.rs", "visible_member_ids"),
        // only narrows a pool that is already the active set
        ("calendar/attendees.rs", "search_invitees"),
        // the caller's own rows
        ("files/views.rs", "shared_with_me"),
        ("notify/prefs.rs", "scopes"),
        ("messaging/conversations.rs", "unread_messages_by_space"),
        // narrows candidates the notification path already took from the engine
        ("notify/prefs.rs", "every_message_recipients"),
        // write side: who is in already, to not add twice
        ("messaging/channels.rs", "add_channel_members"),
        // the engine's own load
        ("permissions/load.rs", "memberships"),
    ];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut stack = vec![root.clone()];
    let mut offenders = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read_dir") {
            let path = entry.expect("entry").path();
            let relative = path
                .strip_prefix(&root)
                .expect("inside src")
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                if relative != "entities" && !relative.starts_with("tests_integration") {
                    stack.push(path);
                }
                continue;
            }
            if !relative.ends_with(".rs")
                || relative.starts_with("tests_integration")
                || relative == "testkit.rs"
                || relative == "seed.rs"
                || relative == "permissions/membership.rs"
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read");
            let lines: Vec<&str> = text.lines().collect();
            // The statement that starts at `at`: up to its `.await` or its closing `);`.
            let statement = |at: usize| -> String {
                let mut end = at;
                while end + 1 < lines.len()
                    && end < at + 30
                    && !lines[end].contains(".await")
                    && !lines[end].trim_end().ends_with(");")
                {
                    end += 1;
                }
                lines[at..=end].join("\n")
            };
            let mut function = String::from("(top level)");
            for (at, line) in lines.iter().enumerate() {
                let trimmed = (*line).trim_start();
                if let Some(rest) = trimmed
                    .strip_prefix("pub(super) async fn ")
                    .or_else(|| trimmed.strip_prefix("pub(crate) async fn "))
                    .or_else(|| trimmed.strip_prefix("pub async fn "))
                    .or_else(|| trimmed.strip_prefix("async fn "))
                    .or_else(|| trimmed.strip_prefix("pub fn "))
                    .or_else(|| trimmed.strip_prefix("fn "))
                {
                    function = rest
                        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .next()
                        .unwrap_or("")
                        .to_owned();
                } else if let Some(rest) = trimmed
                    .strip_prefix("const ")
                    .or_else(|| trimmed.strip_prefix("pub const "))
                {
                    function = rest.split(':').next().unwrap_or("").trim().to_owned();
                }
                let space_read = line.contains("space_members::Entity::")
                    && !line.contains("delete_by_id")
                    || line.contains("FROM space_members")
                    || line.contains("JOIN space_members");
                let channel_read = line.contains("channel_members::Entity::find()")
                    || line.contains("FROM channel_members")
                    || line.contains("JOIN channel_members");
                let here = (relative.as_str(), function.as_str());
                let filtered = || {
                    let sql = statement(at);
                    sql.contains("active_sql!")
                        || sql.contains("ACTIVE_SQL")
                        || sql.contains("{active}")
                        || sql.contains("active_condition")
                };
                if (space_read && !filtered() && !SPACE_MEMBERS.contains(&here))
                    || (channel_read && !CHANNEL_MEMBERS.contains(&here))
                {
                    offenders.push(format!("{relative} in {function}: {}", trimmed.trim()));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "bare reads; go through permissions::membership or allow-list them:\n{}",
        offenders.join("\n")
    );
}

/// Put people in the channel the way joining does, bypassing the routes.
async fn join(app: &TestApp, channel: Uuid, users: &[Uuid]) {
    for user in users {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')",
            vec![channel.into(), (*user).into()],
        )
        .await
        .expect("channel member");
    }
}

/// Every frame type that reaches `ws` within a short window.
async fn frame_types(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
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
async fn an_expired_guest_in_a_channel_hears_counts_and_lists_nothing() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    // A guest who is running when the sockets open, and ends later.
    let late = guest_ending(&app.db, fx.space, "1 hour").await;
    join(&app, fx.general, &[fx.member, fx.active, fx.expired, late]).await;
    let owner = app.cookie_for(fx.owner).await;
    let late_cookie = app.cookie_for(late).await;
    let active = app.cookie_for(fx.active).await;

    let mut late_ws = app.connect_ws(&late_cookie).await;
    let mut running_ws = app.connect_ws(&active).await;
    let newcomer = make_user(&app.db, "newcomer").await;
    crate::testkit::add_member(&app.db, fx.space, newcomer, "member").await;
    let path = format!("/api/v1/channels/{}/members", fx.general);
    let add = |user: Uuid| {
        call(
            &app,
            reqwest::Method::POST,
            &path,
            &owner,
            Some(json!({ "user_ids": [user] })),
        )
    };
    // While they are active, the frame reaches them: the later silence is not an artefact.
    assert_eq!(add(newcomer).await.0, 200);
    let before = frame_types(&mut late_ws).await;
    assert!(before.contains(&"message.created".to_owned()), "{before:?}");
    frame_types(&mut running_ws).await;

    // Their access ends.
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() - interval '1 second' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), late.into()],
    )
    .await
    .expect("expire");

    // Not counted, not listed (two ended guests, one running, the member and the owner).
    let (_, channels) = get_json(
        &app,
        &format!("/api/v1/spaces/{}/channels", fx.space),
        &owner,
    )
    .await;
    let general = channels
        .as_array()
        .expect("channels")
        .iter()
        .find(|c| c["id"] == fx.general.to_string())
        .expect("general");
    assert_eq!(
        general["member_count"], 4,
        "owner, member, newcomer, running guest"
    );
    let (_, listed) = get_json(
        &app,
        &format!("/api/v1/channels/{}/members", fx.general),
        &owner,
    )
    .await;
    let listed = ids(&listed, "user_id");
    assert_eq!(listed.len(), 4, "{listed:?}");
    assert!(!listed.contains(&late.to_string()));
    assert!(!listed.contains(&fx.expired.to_string()));

    // Hears nothing more: another joining notice and a role change reach the others only.
    let second = make_user(&app.db, "second").await;
    crate::testkit::add_member(&app.db, fx.space, second, "member").await;
    assert_eq!(add(second).await.0, 200);
    let (status, body) = call(
        &app,
        reqwest::Method::PATCH,
        &format!("/api/v1/channels/{}/members/{}", fx.general, fx.member),
        &owner,
        Some(json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let running = frame_types(&mut running_ws).await;
    assert!(
        running.contains(&"message.created".to_owned()),
        "{running:?}"
    );
    assert!(
        running.contains(&"channel.membership".to_owned()),
        "{running:?}"
    );
    let ended = frame_types(&mut late_ws).await;
    assert!(
        !ended
            .iter()
            .any(|k| k == "message.created" || k == "channel.membership"),
        "{ended:?}"
    );
}

/// The channel list counts every channel's people in a fixed number of queries.
#[tokio::test]
async fn channel_counts_come_in_one_pass() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let mut channels = vec![fx.general];
    for n in 0..4 {
        let id = Uuid::new_v4();
        exec(
            &app.db,
            "INSERT INTO conversations (id, space_id, kind) VALUES ($1, $2, 'channel')",
            vec![id.into(), fx.space.into()],
        )
        .await
        .expect("conversation");
        exec(
            &app.db,
            "INSERT INTO channels (id, space_id, name, type) VALUES ($1, $2, $3, 'public')",
            vec![id.into(), fx.space.into(), format!("extra-{n}").into()],
        )
        .await
        .expect("channel");
        channels.push(id);
    }
    for channel in &channels {
        join(&app, *channel, &[fx.member, fx.active, fx.expired]).await;
    }
    // A separate connection, so only this call is counted.
    let url = std::env::var("RUCHOIR_TEST_DATABASE_URL").expect("url");
    let mut db = sea_orm::Database::connect(url).await.expect("connect");
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = seen.clone();
    db.set_metric_callback(move |_| {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let counts = membership::channel_member_counts(&db, fx.space, channels.clone())
        .await
        .expect("counts");
    assert_eq!(
        seen.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "two queries for five channels"
    );
    for channel in &channels {
        let expected = if *channel == fx.general { 3 } else { 2 };
        assert_eq!(counts[channel], expected, "the people still in the space");
        assert_eq!(
            membership::channel_members_active(&db, *channel)
                .await
                .expect("one")
                .len() as u64,
            counts[channel]
        );
    }
}

#[tokio::test]
async fn an_ended_guest_cannot_come_back_through_an_invitation_link() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let expired = app.cookie_for(fx.expired).await;
    let (status, body) = call(
        &app,
        reqwest::Method::POST,
        &format!("/api/v1/spaces/{}/invitations", fx.space),
        &owner,
        Some(json!({ "role": "member" })),
    )
    .await;
    assert!(status == 200 || status == 201, "{status} {body}");
    let created: Value = serde_json::from_str(&body).expect("json");
    let token = created["url"]
        .as_str()
        .expect("url")
        .rsplit(['/', '='])
        .next()
        .expect("token")
        .to_owned();
    let uses = |app: &TestApp| {
        let db = app.db.clone();
        let space = fx.space;
        async move {
            space_invitations::Entity::find()
                .filter(space_invitations::Column::SpaceId.eq(space))
                .one(&db)
                .await
                .expect("invitation")
                .expect("row")
                .uses
        }
    };
    let before = uses(&app).await;
    let (status, ended_body) = call(
        &app,
        reqwest::Method::POST,
        &format!("/api/v1/invitations/{token}/accept"),
        &expired,
        None,
    )
    .await;
    let (unknown_status, unknown_body) = call(
        &app,
        reqwest::Method::POST,
        "/api/v1/invitations/not-a-real-token/accept",
        &expired,
        None,
    )
    .await;
    assert_eq!(status, 404, "{ended_body}");
    assert_eq!((status, ended_body), (unknown_status, unknown_body));
    assert_eq!(uses(&app).await, before, "no use is spent");
    let rows = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(fx.general))
        .filter(channel_members::Column::UserId.eq(fx.expired))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(rows, 0, "nothing is written");
}

#[tokio::test]
async fn an_ended_guest_cannot_act_on_ranks() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let expired = app.cookie_for(fx.expired).await;
    let space = fx.space;
    // Roles read, a group made, an invitation to the admin role, a member removed: refused.
    for (method, path, body) in [
        (
            reqwest::Method::GET,
            format!("/api/v1/spaces/{space}/roles"),
            None,
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/groups"),
            Some(json!({ "name": "Sneaky" })),
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/invitations"),
            Some(json!({ "role": "admin" })),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/spaces/{space}/members/{}", fx.active),
            None,
        ),
    ] {
        let (status, text) = call(&app, method, &path, &expired, body).await;
        assert_eq!(status, 403, "{path}: {text}");
    }
    let actor = crate::permissions::delegation::actor_rank(&app.db, space, fx.expired)
        .await
        .expect("rank");
    assert!(actor.is_none(), "an ended guest has no rank as an actor");
}

/// The rule routes (lot 4) honour the end date: an ended guest cannot edit or read the access of a
/// channel, and an entry cannot be aimed at them, exactly as for somebody who was never in the space.
#[tokio::test]
async fn an_expired_guest_is_outside_the_rule_routes() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let expired = app.cookie_for(fx.expired).await;
    let entries = format!(
        "/api/v1/spaces/{}/access/channel/{}/entries",
        fx.space, fx.general
    );
    let access = format!("/api/v1/spaces/{}/access/channel/{}", fx.space, fx.general);
    let aim =
        |user: Uuid| Some(json!({ "target": { "kind": "user", "id": user }, "level": "read" }));

    let (status, _) = call(&app, reqwest::Method::GET, &access, &expired, None).await;
    assert_eq!(status, 403, "an ended guest reads no access dialog");
    let (status, _) = call(
        &app,
        reqwest::Method::PUT,
        &entries,
        &expired,
        aim(fx.member),
    )
    .await;
    assert_eq!(status, 403, "an ended guest edits no access");

    let (stranger_status, stranger_body) = call(
        &app,
        reqwest::Method::PUT,
        &entries,
        &owner,
        aim(fx.stranger),
    )
    .await;
    let (status, body) = call(
        &app,
        reqwest::Method::PUT,
        &entries,
        &owner,
        aim(fx.expired),
    )
    .await;
    assert!(
        stranger_status >= 400,
        "control: a stranger is no target: {stranger_body}"
    );
    assert_eq!(
        (status, body.as_str()),
        (stranger_status, stranger_body.as_str()),
        "an ended guest is refused as a stranger is"
    );
    let (status, _) = call(&app, reqwest::Method::PUT, &entries, &owner, aim(fx.active)).await;
    assert!(status < 300, "control: a running guest is a target");
}

/// A channel moderator whose guest access ended edits no access: the editor's channel role is no
/// standing once the person is out of the space.
#[tokio::test]
async fn an_ended_guest_who_moderated_a_channel_edits_no_access() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    exec(
        &app.db,
        "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'admin')",
        vec![fx.general.into(), fx.expired.into()],
    )
    .await
    .expect("moderator");
    let expired = app.cookie_for(fx.expired).await;
    let base = format!("/api/v1/spaces/{}/access/channel/{}", fx.space, fx.general);
    let (status, _) = call(
        &app,
        reqwest::Method::PUT,
        &format!("{base}/entries"),
        &expired,
        Some(json!({ "target": { "kind": "user", "id": fx.member }, "level": "read" })),
    )
    .await;
    assert_eq!(status, 403, "an ended guest edits no access");
}

/// A direct conversation between `people`, rows only (what the API would have made).
async fn make_dm(app: &TestApp, space: Uuid, people: &[Uuid]) -> Uuid {
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

async fn dm_notices(app: &TestApp, user: Uuid, dm: Uuid) -> usize {
    notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(user))
        .filter(notifications::Column::ConversationId.eq(dm))
        .all(&app.db)
        .await
        .expect("notices")
        .len()
}

async fn dm_audience(app: &TestApp, space: Uuid, dm: Uuid) -> Vec<Uuid> {
    let access = crate::messaging::authz::ConversationAccess {
        conversation_id: dm,
        space_id: space,
        kind: crate::messaging::authz::ConversationKind::Direct,
        channel_type: None,
    };
    crate::messaging::authz::conversation_audience(&app.db, &access)
        .await
        .expect("audience")
}

#[tokio::test]
async fn an_expired_guest_reads_and_hears_no_direct_message_until_reactivated() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "1 hour").await;
    let dm = make_dm(&app, fx.space, &[fx.member, guest]).await;
    let member = app.cookie_for(fx.member).await;
    let guest_cookie = app.cookie_for(guest).await;
    let messages = format!("/api/v1/conversations/{dm}/messages");

    // Running: the guest writes, the member answers and is heard.
    let (status, text) = call(
        &app,
        reqwest::Method::POST,
        &messages,
        &guest_cookie,
        Some(json!({ "body": "mine" })),
    )
    .await;
    assert_eq!(status, 201, "{text}");
    let mine = serde_json::from_str::<Value>(&text).expect("json")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let (status, text) = call(
        &app,
        reqwest::Method::POST,
        &messages,
        &member,
        Some(json!({ "body": "theirs" })),
    )
    .await;
    assert_eq!(status, 201, "{text}");
    let theirs = serde_json::from_str::<Value>(&text).expect("json")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(dm_notices(&app, guest, dm).await, 1);
    assert!(dm_audience(&app, fx.space, dm).await.contains(&guest));

    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() - interval '1 second' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("expire");

    let emoji = "%F0%9F%91%8D";
    let refused = |method: reqwest::Method, path: String, body: Option<Value>| {
        let app = &app;
        let cookie = guest_cookie.clone();
        async move { call(app, method, &path, &cookie, body).await.0 }
    };
    assert_eq!(
        refused(reqwest::Method::GET, messages.clone(), None).await,
        403,
        "list"
    );
    assert_eq!(
        refused(
            reqwest::Method::POST,
            messages.clone(),
            Some(json!({ "body": "still here?" }))
        )
        .await,
        403,
        "send"
    );
    assert_eq!(
        refused(
            reqwest::Method::PUT,
            format!("/api/v1/messages/{theirs}/reactions/{emoji}"),
            None
        )
        .await,
        403,
        "react"
    );
    assert_eq!(
        refused(
            reqwest::Method::PATCH,
            format!("/api/v1/messages/{mine}"),
            Some(json!({ "body": "edited" }))
        )
        .await,
        403,
        "edit"
    );

    // Not heard: out of the audience, no notice for what the member says next.
    assert_eq!(dm_audience(&app, fx.space, dm).await, vec![fx.member]);
    let (status, _) = call(
        &app,
        reqwest::Method::POST,
        &messages,
        &member,
        Some(json!({ "body": "anyone?" })),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(dm_notices(&app, guest, dm).await, 1, "no new notice");

    // Nothing was deleted: reactivated, the history is theirs again.
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() + interval '1 day' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("reactivate");
    let (status, page) = get_json(&app, &messages, &guest_cookie).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["messages"].as_array().expect("messages").len(), 3);
    assert!(dm_audience(&app, fx.space, dm).await.contains(&guest));
}

#[tokio::test]
async fn a_removed_member_gets_403_on_their_old_direct_message() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let leaver = make_user(&app.db, "leaver").await;
    crate::testkit::add_member(&app.db, fx.space, leaver, "member").await;
    let dm = make_dm(&app, fx.space, &[fx.member, leaver]).await;
    let cookie = app.cookie_for(leaver).await;
    let messages = format!("/api/v1/conversations/{dm}/messages");
    assert_eq!(get_json(&app, &messages, &cookie).await.0, 200);

    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), leaver.into()],
    )
    .await
    .expect("remove");
    assert_eq!(get_json(&app, &messages, &cookie).await.0, 403);
    assert_eq!(dm_audience(&app, fx.space, dm).await, vec![fx.member]);
}

/// A rule kept for a guest whose access ended still reads as a guest's.
#[tokio::test]
async fn a_kept_person_rule_on_an_ended_guest_keeps_the_guest_flag() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let base = format!("/api/v1/spaces/{}/access/channel/{}", fx.space, fx.general);
    let guest = guest_ending(&app.db, fx.space, "1 hour").await;
    let (status, text) = call(
        &app,
        reqwest::Method::PUT,
        &format!("{base}/entries"),
        &owner,
        Some(json!({ "target": { "kind": "user", "id": guest }, "level": "read" })),
    )
    .await;
    assert!(status < 300, "{status} {text}");
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() - interval '1 second' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("expire");

    let (status, dialog) = get_json(&app, &base, &owner).await;
    assert_eq!(status, 200, "{dialog}");
    let line = dialog["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["target"]["id"] == guest.to_string())
        .unwrap_or_else(|| panic!("the kept rule is listed: {dialog}"));
    assert_eq!(line["guest"], true, "{line}");
}
