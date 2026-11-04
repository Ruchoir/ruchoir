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

/// Every read of `space_members` outside `permissions/membership.rs` is one that is meant to see
/// people whose access ended (management, the owner lookups, the writes and the import) and is on
/// this list, with its file and function. A new read must go through `membership`, or be added here
/// with its reason.
#[test]
fn no_bare_space_members_reads() {
    const ALLOWED: &[(&str, &str)] = &[
        // management: sees ended guests
        ("messaging/spaces.rs", "update_member_role"),
        ("messaging/spaces.rs", "remove_member"),
        ("messaging/spaces.rs", "leave_space"),
        ("messaging/invitations.rs", "accept_invitation"),
        ("permissions/delegation.rs", "rank_of"),
        ("calendar/authz.rs", "create_space_default"),
        // the edition's seat count: guests are not counted
        ("edition.rs", "seats_used"),
        // the rows the permission engine itself loads
        ("permissions/load.rs", "PEOPLE"),
        // writes and the import
        ("importer/routes.rs", "invite_one"),
        ("importer/run.rs", "import_conversations"),
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
            let mut function = String::from("(top level)");
            let lines: Vec<&str> = text.lines().collect();
            // A raw statement is fine when it carries the shared definition of "active" nearby.
            let marked = |at: usize| {
                lines[at.saturating_sub(3)..(at + 12).min(lines.len())]
                    .iter()
                    .any(|l| {
                        l.contains("active_sql!")
                            || l.contains("ACTIVE_SQL")
                            || l.contains("{active}")
                    })
            };
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
                let reads = line.contains("space_members::Entity::")
                    && !line.contains("delete_by_id")
                    || line.contains("FROM space_members")
                    || line.contains("JOIN space_members");
                if reads
                    && !marked(at)
                    && !ALLOWED.contains(&(relative.as_str(), function.as_str()))
                {
                    offenders.push(format!("{relative} in {function}: {}", trimmed.trim()));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "bare reads of space_members; go through permissions::membership or allow-list them:\n{}",
        offenders.join("\n")
    );
}
