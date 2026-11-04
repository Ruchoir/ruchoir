//! The people block of the import plan, and the seats refusal at start (permissions lot 6). Same
//! harness as the parent module; archives are unpacked directories in the import directory.

use super::*;

use crate::edition::{seats_used, Edition, Entitlement, SeatCheck};

/// An edition selling `0` seats on every space, counted for real from owners and members.
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

    async fn import_custom_role(
        &self,
        _txn: &sea_orm::DatabaseTransaction,
        _space_id: Uuid,
        _role: &crate::edition::ImportedRole,
        _actor: Uuid,
    ) -> Result<crate::edition::ImportedRoleOutcome, sea_orm::DbErr> {
        Ok(crate::edition::ImportedRoleOutcome::FallBack)
    }
}

struct Harness {
    scratch: ScratchDb,
    app: TestApp,
    admin: String,
    /// The name of an archive in the import directory that fills the seeded space with `new`
    /// people who are not here yet.
    archive: String,
    space_name: String,
}

/// A licensed instance of `seats` per space, whose seeded "Test Space" holds three members, and an
/// archive filling that space with `new` accounts nobody has met.
async fn harness(seats: u32, new: usize) -> Option<Harness> {
    // A database of its own: the plan and the running-import guard look at the whole instance, and
    // the shared database holds other tests' spaces and open imports.
    let scratch = ScratchDb::create().await?;
    let dir = std::env::temp_dir().join(format!("ruchoir-people-plan-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("import dir");
    let place = dir.clone();
    let url = scratch.url.clone();
    let app = boot_as(Arc::new(Seats(seats)), None, move |c| {
        c.import_dir = Some(place);
        c.database_url = url;
    })
    .await?;
    let fx = seed(&app.db).await;
    // The shared database holds many spaces called "Test Space": this one has a name of its own,
    // or the plan would call it ambiguous.
    let space_name = format!("Atelier {}", Uuid::new_v4().simple());
    let mut renamed: spaces::ActiveModel = spaces::Entity::find_by_id(fx.space_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("space")
        .into();
    renamed.name = Set(space_name.clone());
    renamed.update(&app.db).await.expect("rename");
    let mut admin: users::ActiveModel = users::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("alice")
        .into();
    admin.is_instance_admin = Set(true);
    admin.update(&app.db).await.expect("promote");

    let name = format!("people-{}", Uuid::new_v4().simple());
    let archive = dir.join(&name);
    std::fs::create_dir_all(&archive).expect("archive dir");
    let write = |file: &str, rows: Vec<Value>| {
        let body: String = rows.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(archive.join(file), body).expect("write");
    };
    write(
        "spaces.jsonl",
        vec![json!({"id": "s", "name": space_name, "visibility": "public"})],
    );
    let people: Vec<Value> = (0..new)
        .map(|i| json!({"id": format!("n{i}"), "email": format!("new{i}-{}@example.test", Uuid::new_v4().simple()), "display_name": format!("New {i}")}))
        .collect();
    write("users.jsonl", people.clone());
    write(
        "channels.jsonl",
        vec![
            json!({"id": "c", "space": "s", "kind": "channel", "name": "General",
            "visibility": "public",
            "members": (0..new).map(|i| format!("n{i}")).collect::<Vec<_>>()}),
        ],
    );
    write("messages.jsonl", vec![]);
    write("files.jsonl", vec![]);
    write(
        "members.jsonl",
        (0..new)
            .map(|i| json!({"space": "s", "user": format!("n{i}"), "role": "member", "roles": []}))
            .collect(),
    );
    std::fs::write(
        archive.join("manifest.json"),
        json!({"format_version": 2, "source": "mattermost", "producer": "test",
               "created_at": "2026-09-13T10:00:00Z", "limits": ["nothing in particular"]})
        .to_string(),
    )
    .expect("manifest");
    let admin_cookie = app.cookie_for(fx.alice).await;
    Some(Harness {
        scratch,
        app,
        admin: admin_cookie,
        archive: name,
        space_name,
    })
}

impl Harness {
    async fn call(&self, path: &str) -> reqwest::Response {
        self.app
            .req(reqwest::Method::POST, path, &self.admin)
            .json(&json!({ "file": self.archive }))
            .send()
            .await
            .expect("request")
    }

    async fn finish(self) {
        let Harness { scratch, app, .. } = self;
        drop(app);
        scratch.drop_it().await;
    }

    async fn jobs(&self) -> u64 {
        use sea_orm::PaginatorTrait;
        crate::entities::import_jobs::Entity::find()
            .count(&self.app.db)
            .await
            .expect("count")
    }
}

#[tokio::test]
async fn the_plan_route_carries_the_people_block() {
    let Some(h) = harness(10, 4).await else {
        return;
    };
    let response = h.call("/api/v1/imports/plan").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    let people = &body["people"];
    assert_eq!(people["administrators"], 0);
    assert_eq!(people["guests"], 0);
    assert_eq!(people["already_here_total"], 0);
    let seats = &people["seats"][0];
    assert_eq!(seats["space"], h.space_name.as_str());
    assert_eq!(seats["used"], 3, "the seeded space holds three members");
    assert_eq!(seats["incoming"], 4);
    assert_eq!(seats["total"], 10);
    assert_eq!(seats["over"], false);
    h.finish().await;
}

#[tokio::test]
async fn start_refuses_402_when_the_seats_are_over_and_writes_no_job() {
    // Three used, four coming, six sold.
    let Some(h) = harness(6, 4).await else {
        return;
    };
    let before = h.jobs().await;
    let response = h.call("/api/v1/imports").await;
    assert_eq!(response.status(), 402);
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["error"], "seats_full");
    assert_eq!(body["seats"], 6);
    assert!(body["pricing_url"].is_string());
    // Three in use, four coming, six sold: one seat short.
    assert_eq!(body["space"], h.space_name.as_str());
    assert_eq!(body["used"], 3);
    assert_eq!(body["incoming"], 4);
    assert_eq!(body["missing"], 1);
    assert_eq!(h.jobs().await, before, "no job row for a refused start");
    h.finish().await;
}

#[tokio::test]
async fn start_accepts_when_the_seats_just_fit() {
    // Three used, four coming, seven sold.
    let Some(h) = harness(7, 4).await else {
        return;
    };
    let response = h.call("/api/v1/imports").await;
    assert_eq!(response.status(), 202);
    h.finish().await;
}

// --- the people pass: standing and seats ---------------------------------------------------------

use crate::edition::CommunityEdition;
use crate::importer::job::{execute_into, Outcome, RunSettings};
use crate::importer::run::RunError;

/// An archive of format `version`: a space, the given accounts (id, address), the given
/// `members.jsonl` lines (user, role, roles), and one conversation per `channels` entry.
fn people_archive(
    version: u32,
    space_name: &str,
    accounts: &[(&str, &str)],
    members: &[(&str, &str, &[&str])],
    channels: &[(&str, &[&str])],
) -> std::path::PathBuf {
    let with_none: Vec<(&str, &[&str], &[&str])> = channels
        .iter()
        .map(|(name, people)| (*name, *people, &[][..]))
        .collect();
    people_archive_with(version, space_name, accounts, members, &with_none)
}

/// [`people_archive`] with the moderators of each conversation: (name, members, moderators).
fn people_archive_with(
    version: u32,
    space_name: &str,
    accounts: &[(&str, &str)],
    members: &[(&str, &str, &[&str])],
    channels: &[(&str, &[&str], &[&str])],
) -> std::path::PathBuf {
    people_archive_full(version, space_name, accounts, members, channels, &[], &[])
}

/// A group of the archive: (id, name, description, members).
type GroupLine<'a> = (&'a str, &'a str, &'a str, &'a [&'a str]);

/// [`people_archive_with`] with groups and roles ((id, name, based_on)).
fn people_archive_full(
    version: u32,
    space_name: &str,
    accounts: &[(&str, &str)],
    members: &[(&str, &str, &[&str])],
    channels: &[(&str, &[&str], &[&str])],
    groups: &[GroupLine<'_>],
    roles: &[(&str, &str, &str)],
) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ruchoir-people-run-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("dir");
    // Source identifiers are remembered across runs of the shared database: every archive spells
    // its own, or it would resolve to another test's space and accounts.
    let tag = Uuid::new_v4().simple().to_string();
    let q = |id: &str| format!("{id}-{tag}");
    let space_ref = q("s");
    let write = |name: &str, rows: Vec<Value>| {
        let body: String = rows.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(dir.join(name), body).expect("write");
    };
    write(
        "spaces.jsonl",
        vec![json!({"id": space_ref, "name": space_name, "visibility": "private"})],
    );
    write(
        "users.jsonl",
        accounts
            .iter()
            .map(|(id, email)| json!({"id": q(id), "email": email, "display_name": id}))
            .collect(),
    );
    write(
        "channels.jsonl",
        channels
            .iter()
            .map(|(name, people, moderators)| {
                let people: Vec<String> = people.iter().map(|p| q(p)).collect();
                let moderators: Vec<String> = moderators.iter().map(|p| q(p)).collect();
                json!({"id": q(name), "space": space_ref, "kind": "channel", "name": name,
                       "visibility": "public", "members": people, "moderators": moderators})
            })
            .collect(),
    );
    write("messages.jsonl", vec![]);
    write("files.jsonl", vec![]);
    if version >= 2 {
        write(
            "members.jsonl",
            members
                .iter()
                .map(|(user, role, roles)| json!({"space": space_ref, "user": q(user), "role": role, "roles": roles}))
                .collect(),
        );
    }
    if version >= 2 {
        write(
            "groups.jsonl",
            groups
                .iter()
                .map(|(id, name, description, people)| {
                    let people: Vec<String> = people.iter().map(|p| q(p)).collect();
                    json!({"id": id, "space": space_ref, "name": name,
                           "description": description, "members": people})
                })
                .collect(),
        );
        write(
            "roles.jsonl",
            roles
                .iter()
                .map(|(id, name, based_on)| json!({"id": id, "space": space_ref, "name": name, "based_on": based_on}))
                .collect(),
        );
    }
    std::fs::write(
        dir.join("manifest.json"),
        json!({"format_version": version, "source": "mattermost", "producer": "test",
               "created_at": "2026-09-13T10:00:00Z", "limits": ["nothing in particular"]})
        .to_string(),
    )
    .expect("manifest");
    dir
}

fn address(id: &str) -> String {
    format!("{id}-{}@example.test", Uuid::new_v4().simple())
}

fn settings(edition: Arc<dyn Edition>) -> RunSettings {
    RunSettings {
        edition,
        ..RunSettings::community(THUMBNAIL_MAX_PX, [7; 32])
    }
}

async fn run_people(
    app: &TestApp,
    importer: Uuid,
    dir: &std::path::Path,
    edition: Arc<dyn Edition>,
) -> (Uuid, Result<Outcome, RunError>) {
    let job = run::start_job(&app.db, "mattermost", importer, None, "{}")
        .await
        .expect("job");
    let outcome = execute_into(
        &app.db,
        Some(&MemorySink::default()),
        dir,
        None,
        importer,
        job,
        settings(edition),
    )
    .await;
    (job, outcome)
}

async fn become_admin(app: &TestApp, user: Uuid) {
    let mut model: users::ActiveModel = users::Entity::find_by_id(user)
        .one(&app.db)
        .await
        .expect("query")
        .expect("user")
        .into();
    model.is_instance_admin = Set(true);
    model.update(&app.db).await.expect("promote");
}

async fn account_of(app: &TestApp, email: &str) -> Uuid {
    users::Entity::find()
        .filter(users::Column::Email.eq(email))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the account exists")
        .id
}

async fn space_named(app: &TestApp, name: &str) -> Uuid {
    spaces::Entity::find()
        .filter(spaces::Column::Name.eq(name))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the space exists")
        .id
}

async fn row_of(app: &TestApp, space: Uuid, user: Uuid) -> Option<space_members::Model> {
    space_members::Entity::find_by_id((space, user))
        .one(&app.db)
        .await
        .expect("query")
}

async fn standing_of(app: &TestApp, space: Uuid, user: Uuid) -> String {
    row_of(app, space, user).await.expect("a row").role
}

fn unique_space() -> String {
    format!("Atelier {}", Uuid::new_v4().simple())
}

#[tokio::test]
async fn a_listed_administrator_in_no_channel_is_admitted() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, email) = (unique_space(), address("zoe"));
    let dir = people_archive(2, &name, &[("zoe", &email)], &[("zoe", "admin", &[])], &[]);
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let zoe = account_of(&app, &email).await;
    assert_eq!(standing_of(&app, space, zoe).await, "admin");
}

#[tokio::test]
async fn listed_roles_arrive_as_written_owner_stays_the_importer() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let importer = users::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("alice")
        .email;
    let (name, a, b, c) = (unique_space(), address("a"), address("b"), address("c"));
    // The importer is listed as a guest: they own the space they create, whatever the archive says.
    let dir = people_archive(
        2,
        &name,
        &[("me", &importer), ("a", &a), ("b", &b), ("c", &c)],
        &[
            ("me", "guest", &[]),
            ("a", "admin", &[]),
            ("b", "member", &[]),
            ("c", "guest", &[]),
        ],
        &[],
    );
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    assert_eq!(standing_of(&app, space, fx.alice).await, "owner");
    for (email, role) in [(&a, "admin"), (&b, "member"), (&c, "guest")] {
        assert_eq!(
            standing_of(&app, space, account_of(&app, email).await).await,
            role
        );
    }
}

#[tokio::test]
async fn nobody_becomes_owner_by_import() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "admin", &[]), ("b", "member", &[])],
        &[("general", &["a", "b"])],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let space = space_named(&app, &name).await;
    let owners = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space))
        .filter(space_members::Column::Role.eq("owner"))
        .all(&app.db)
        .await
        .expect("query");
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].user_id, fx.alice, "only the importer");
}

#[tokio::test]
async fn a_guest_arrives_a_guest_with_no_end_date_and_no_seat() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, g) = (unique_space(), address("g"));
    let dir = people_archive(2, &name, &[("g", &g)], &[("g", "guest", &[])], &[]);
    // Two seats sold, the importer takes one: a guest must still fit, and take none.
    run_people(&app, fx.alice, &dir, Arc::new(Seats(1)))
        .await
        .1
        .expect("the run completes");
    let space = space_named(&app, &name).await;
    let row = row_of(&app, space, account_of(&app, &g).await)
        .await
        .expect("row");
    assert_eq!(row.role, "guest");
    assert!(row.expires_at.is_none());
    assert_eq!(
        crate::edition::seats_used(&app.db, space)
            .await
            .expect("seats"),
        1
    );
}

#[tokio::test]
async fn a_person_already_in_the_space_keeps_their_role_up_or_down() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let (up, down) = (address("up"), address("down"));
    let (up_id, down_id) = (
        make_user_with(&app, &up).await,
        make_user_with(&app, &down).await,
    );
    for (user, role) in [(up_id, "member"), (down_id, "admin")] {
        space_members::ActiveModel {
            space_id: Set(space),
            user_id: Set(user),
            role: Set(role.to_owned()),
            ..Default::default()
        }
        .insert(&app.db)
        .await
        .expect("member");
    }
    // The archive says the opposite of what is here, both ways.
    let dir = people_archive(
        2,
        &name,
        &[("up", &up), ("down", &down)],
        &[("up", "admin", &[]), ("down", "member", &[])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    assert_eq!(standing_of(&app, space, up_id).await, "member");
    assert_eq!(standing_of(&app, space, down_id).await, "admin");
}

async fn make_user_with(app: &TestApp, email: &str) -> Uuid {
    let id = Uuid::new_v4();
    users::ActiveModel {
        id: Set(id),
        email: Set(email.to_owned()),
        display_name: Set("Someone".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("user");
    id
}

#[tokio::test]
async fn an_ended_guest_row_blocks_the_insert_and_stays_ended() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let email = address("gone");
    let gone = make_user_with(&app, &email).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO space_members (space_id, user_id, role, expires_at) \
             VALUES ($1, $2, 'guest', now() - interval '1 day')",
            [space.into(), gone.into()],
        ))
        .await
        .expect("ended guest");
    let dir = people_archive(
        2,
        &name,
        &[("gone", &email)],
        &[("gone", "member", &[])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let row = row_of(&app, space, gone).await.expect("row");
    assert_eq!(row.role, "guest");
    assert!(row.expires_at.expect("still ended") < OffsetDateTime::now_utc());
}

#[tokio::test]
async fn the_imported_from_column_is_written_on_new_rows_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let (old, new) = (address("old"), address("new"));
    let old_id = make_user_with(&app, &old).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(old_id),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let dir = people_archive(
        2,
        &name,
        &[("old", &old), ("new", &new)],
        &[("old", "member", &[]), ("new", "member", &[])],
        &[],
    );
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    assert_eq!(
        row_of(&app, space, old_id)
            .await
            .expect("row")
            .imported_from,
        None
    );
    assert_eq!(
        row_of(&app, space, account_of(&app, &new).await)
            .await
            .expect("row")
            .imported_from,
        Some(format!("mattermost:{job}"))
    );
    assert_eq!(
        row_of(&app, space, fx.alice)
            .await
            .expect("row")
            .imported_from,
        None
    );
}

#[tokio::test]
async fn a_person_in_two_spaces_counts_a_seat_in_each_member_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (first, second, email) = (unique_space(), unique_space(), address("p"));
    for name in [&first, &second] {
        let dir = people_archive(2, name, &[("p", &email)], &[("p", "member", &[])], &[]);
        run_people(&app, fx.alice, &dir, Arc::new(Seats(5)))
            .await
            .1
            .expect("the run completes");
    }
    for name in [&first, &second] {
        let space = space_named(&app, name).await;
        // The importer and the person.
        assert_eq!(
            crate::edition::seats_used(&app.db, space)
                .await
                .expect("seats"),
            2
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_last_seat_goes_to_one_of_two_racing_arrivals() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let (a, b) = (
        make_user_with(&app, &address("ra")).await,
        make_user_with(&app, &address("rb")).await,
    );
    // Two seats: the owner has one, one is left for two arrivals.
    let edition: Arc<dyn Edition> = Arc::new(Seats(2));
    let (db1, db2) = (app.db.clone(), app.db.clone());
    let (e1, e2) = (edition.clone(), edition.clone());
    // Both arrivals leave the gate together, so both really contend for the one seat.
    let gate = Arc::new(tokio::sync::Barrier::new(2));
    let (g1, g2) = (gate.clone(), gate);
    let first = tokio::spawn(async move {
        g1.wait().await;
        crate::importer::people::admit(&db1, e1.as_ref(), space, a, "member", "x:1").await
    });
    let second = tokio::spawn(async move {
        g2.wait().await;
        crate::importer::people::admit(&db2, e2.as_ref(), space, b, "member", "x:1").await
    });
    let (first, second) = (first.await.expect("join"), second.await.expect("join"));
    let added = [&first, &second]
        .iter()
        .filter(|r| matches!(r, Ok(crate::importer::people::Admitted::Added)))
        .count();
    let refused = [&first, &second]
        .iter()
        .filter(|r| matches!(r, Err(RunError::SeatsFull { .. })))
        .count();
    assert_eq!((added, refused), (1, 1));
    assert_eq!(
        crate::edition::seats_used(&app.db, space)
            .await
            .expect("seats"),
        2
    );
}

#[tokio::test]
async fn a_run_stopped_on_seats_resumes_after_freeing_one() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let squatter = make_user_with(&app, &address("squat")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(squatter),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let (a, b) = (address("a"), address("b"));
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[],
    );
    // Owner and squatter use two of three seats: one of the two arrivals fits.
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    assert!(
        matches!(outcome, Err(RunError::SeatsFull { .. })),
        "{outcome:?}"
    );
    let row = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(row.status, "failed");
    let sentence = row.error.expect("a sentence");
    assert!(sentence.contains("has no seat left"), "{sentence}");
    assert!(sentence.contains(&name), "{sentence}");
    assert!(
        row_of(&app, space, account_of(&app, &a).await)
            .await
            .is_some(),
        "kept"
    );
    assert!(row_of(&app, space, account_of(&app, &b).await)
        .await
        .is_none());

    // Free a seat, and the same archive finishes.
    space_members::Entity::delete_by_id((space, squatter))
        .exec(&app.db)
        .await
        .expect("free");
    let (_, again) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    again.expect("the second run completes");
    assert!(row_of(&app, space, account_of(&app, &b).await)
        .await
        .is_some());
}

#[tokio::test]
async fn a_resumed_run_counts_what_it_already_added_and_keeps_only_others() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let (a, b) = (address("a"), address("b"));
    let squatter = make_user_with(&app, &address("sq")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(squatter),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[],
    );
    // Owner and squatter use two of three seats: `a` fits, `b` does not.
    let (job, first) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    assert!(matches!(first, Err(RunError::SeatsFull { .. })));
    space_members::Entity::delete_by_id((space, squatter))
        .exec(&app.db)
        .await
        .expect("free a seat");
    // The same job resumes. `a` is this import's own earlier work, not somebody "left as they were".
    let outcome = execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(Arc::new(Seats(3))),
    )
    .await
    .expect("the resume completes");
    let people = outcome.written.people;
    assert_eq!(people.added, 2, "a (earlier) and b");
    assert!(
        people.kept.iter().all(|name| name != "a"),
        "{:?}",
        people.kept
    );
}

#[tokio::test]
async fn the_run_stops_when_the_space_filled_since_the_plan() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let email = address("late");
    let dir = people_archive(
        2,
        &name,
        &[("late", &email)],
        &[("late", "member", &[])],
        &[],
    );
    // The plan sees one seat free for the one arrival.
    let edition: Arc<dyn Edition> = Arc::new(Seats(2));
    let (index, _) = crate::importer::check::check(&dir, None).expect("check");
    let existing = crate::importer::job::existing_for(&app.db, fx.alice, edition.as_ref())
        .await
        .expect("existing");
    let plan = crate::importer::plan::build(&index, &existing);
    let people = crate::importer::plan::people_plan(&index, &plan, &existing);
    let line = people
        .seats
        .iter()
        .find(|l| l.space == name)
        .expect("a seats line");
    assert!(!line.over);
    // Somebody takes the seat between the plan and the run.
    let other = make_user_with(&app, &address("other")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(other),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");

    let (job, outcome) = run_people(&app, fx.alice, &dir, edition).await;
    assert!(
        matches!(outcome, Err(RunError::SeatsFull { .. })),
        "{outcome:?}"
    );
    let row = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(row.status, "failed");
    assert_eq!(
        crate::edition::seats_used(&app.db, space)
            .await
            .expect("seats"),
        2
    );
}

#[tokio::test]
async fn a_rerun_changes_no_role_and_adds_no_group() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "admin", &[]), ("b", "guest", &[])],
        &[("general", &["a", "b"], &["a"])],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("first run");
    let space = space_named(&app, &name).await;
    let (a_id, b_id) = (account_of(&app, &a).await, account_of(&app, &b).await);
    // Somebody changes a role by hand, then the same archive runs again.
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = $2",
            [space.into(), a_id.into()],
        ))
        .await
        .expect("demote");
    let (_, second) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let second = second.expect("second run");
    assert_eq!(second.written.people.added, 0);
    assert_eq!(second.written.people.groups, 0);
    assert_eq!(second.written.moderators, 0, "nothing is promoted twice");
    assert_eq!(
        channel_role(&app, space, "general", a_id).await.as_deref(),
        Some("admin")
    );
    assert_eq!(
        channel_role(&app, space, "general", b_id).await.as_deref(),
        Some("member")
    );
    assert_eq!(group_rows(&app, space).await.len(), 1, "no second group");
    assert_eq!(standing_of(&app, space, a_id).await, "member");
    assert_eq!(standing_of(&app, space, b_id).await, "guest");
}

#[tokio::test]
async fn a_format_1_archive_imports_exactly_as_before() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive(
        1,
        &name,
        &[("a", &a), ("b", &b)],
        &[],
        &[("general", &["a", "b"])],
    );
    // A members file that a format 1 archive should never carry is ignored.
    std::fs::write(
        dir.join("members.jsonl"),
        format!(
            "{}\n",
            json!({"space": "s", "user": "a", "role": "admin", "roles": []})
        ),
    )
    .expect("stray file");
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let space = space_named(&app, &name).await;
    for email in [&a, &b] {
        assert_eq!(
            standing_of(&app, space, account_of(&app, email).await).await,
            "member"
        );
    }
}

#[tokio::test]
async fn a_scoped_import_creates_only_its_own_space_and_roles_still_apply() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // bob administers nothing: his import is scoped, and an address other than his is withheld.
    let name = unique_space();
    let dir = people_archive(2, &name, &[("c", "")], &[("c", "admin", &[])], &[]);
    run_people(&app, fx.bob, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let space = space_named(&app, &name).await;
    assert_eq!(standing_of(&app, space, fx.bob).await, "owner");
    let others = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space))
        .all(&app.db)
        .await
        .expect("query");
    assert_eq!(
        others.len(),
        2,
        "bob and the account created for the archive's person"
    );
    assert!(others.iter().any(|m| m.role == "admin"));
}

async fn count(app: &TestApp, sql: &str, values: Vec<sea_orm::Value>) -> i64 {
    app.db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get("", "n")
        .expect("n")
}

#[tokio::test]
async fn a_direct_conversation_stopped_on_seats_is_finished_by_the_resume() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let space_ref = unique_ref("s");
    let (u1, u2, u3) = (unique_ref("u1"), unique_ref("u2"), unique_ref("u3"));
    let emails = [address("u1"), address("u2"), address("u3")];
    let mut direct = source_channel(&unique_ref("dm"), &space_ref, "direct", &[&u1, &u2, &u3]);
    direct.name = String::new();
    let index = Index {
        channels: vec![direct],
        ..import_index(
            vec![
                source_user(&u1, &emails[0]),
                source_user(&u2, &emails[1]),
                source_user(&u3, &emails[2]),
            ],
            vec![source_space(&space_ref, &name)],
        )
    };
    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan::build(&index, &Existing::default()))
        .await
        .expect("accounts");
    let (_, spaces) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");

    // The owner holds one of two seats: the first participant fits, the second does not.
    let stopped =
        run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice, &Seats(2)).await;
    assert!(
        matches!(stopped, Err(RunError::SeatsFull { .. })),
        "{stopped:?}"
    );
    let conversations = || {
        count(
            &app,
            "SELECT count(*)::bigint AS n FROM conversations WHERE space_id = $1 AND kind = 'direct'",
            vec![space.into()],
        )
    };
    assert_eq!(
        conversations().await,
        1,
        "the half-written conversation exists"
    );

    // Seats are freed and the same run resumes: the conversation is found, not made again.
    run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice, &Seats(10))
        .await
        .expect("the resume completes");
    assert_eq!(conversations().await, 1, "still one conversation");
    let participants = count(
        &app,
        "SELECT count(*)::bigint AS n FROM dm_participants p JOIN conversations c ON c.id = p.dm_id \
         WHERE c.space_id = $1",
        vec![space.into()],
    )
    .await;
    assert_eq!(participants, 3, "and everybody is in it");
}

// --- channel moderators and channel-only people -----------------------------------------------

async fn channel_role(app: &TestApp, space: Uuid, name: &str, user: Uuid) -> Option<String> {
    let channel = crate::entities::channels::Entity::find()
        .filter(crate::entities::channels::Column::SpaceId.eq(space))
        .filter(crate::entities::channels::Column::Name.eq(name))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the channel exists");
    crate::entities::channel_members::Entity::find_by_id((channel.id, user))
        .one(&app.db)
        .await
        .expect("query")
        .map(|row| row.role)
}

#[tokio::test]
async fn a_channel_moderator_gets_the_admin_channel_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive_with(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[("projets", &["a", "b"], &["a"])],
    );
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let outcome = outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let (a_id, b_id) = (account_of(&app, &a).await, account_of(&app, &b).await);
    assert_eq!(
        channel_role(&app, space, "projets", a_id).await.as_deref(),
        Some("admin")
    );
    assert_eq!(
        channel_role(&app, space, "projets", b_id).await.as_deref(),
        Some("member")
    );
    assert_eq!(outcome.written.moderators, 1);
}

#[tokio::test]
async fn moderators_are_the_channel_members_the_rules_call_moderators() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive_with(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[("projets", &["a", "b"], &["a"])],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let space = space_named(&app, &name).await;
    let channel = crate::entities::channels::Entity::find()
        .filter(crate::entities::channels::Column::SpaceId.eq(space))
        .filter(crate::entities::channels::Column::Name.eq("projets"))
        .one(&app.db)
        .await
        .expect("query")
        .expect("channel")
        .id;
    let resource = crate::permissions::rules::ResourceRef::Channel(channel);
    let editor = |user| crate::permissions::rules::editor_of(&app.state, space, user, resource);
    let moderator = editor(account_of(&app, &a).await).await.expect("query");
    assert!(
        moderator
            .is_some_and(|e| e.kind == crate::permissions::rules::EditorKind::ChannelModerator),
        "the engine reads the imported admin role as a moderator"
    );
    assert!(editor(account_of(&app, &b).await)
        .await
        .expect("query")
        .is_none());
}

#[tokio::test]
async fn a_moderator_who_is_a_guest_arrives_a_plain_member() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, g) = (unique_space(), address("g"));
    let dir = people_archive_with(
        2,
        &name,
        &[("g", &g)],
        &[("g", "guest", &[])],
        &[("projets", &["g"], &["g"])],
    );
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let outcome = outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let g_id = account_of(&app, &g).await;
    assert_eq!(
        channel_role(&app, space, "projets", g_id).await.as_deref(),
        Some("member")
    );
    assert_eq!(outcome.written.moderators, 0);
}

/// A space that already has its "general" channel, with `old` in it as a plain member.
async fn space_with_general(app: &TestApp, owner: Uuid, old: Uuid) -> (String, Uuid) {
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, owner)
        .await
        .expect("space");
    let channel = crate::entities::channels::Entity::find()
        .filter(crate::entities::channels::Column::SpaceId.eq(space))
        .filter(crate::entities::channels::Column::Name.eq("general"))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the default channel")
        .id;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(old),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space member");
    crate::entities::channel_members::ActiveModel {
        channel_id: Set(channel),
        user_id: Set(old),
        role: Set("member".to_owned()),
        notification_level: Set("default".to_owned()),
        muted: Set(false),
        favorite: Set(false),
        joined_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(&app.db)
    .await
    .expect("channel member");
    (name, space)
}

#[tokio::test]
async fn an_existing_channel_member_keeps_their_channel_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let email = address("old");
    let old = make_user_with(&app, &email).await;
    let (name, space) = space_with_general(&app, fx.alice, old).await;
    let dir = people_archive_with(
        2,
        &name,
        &[("old", &email)],
        &[("old", "member", &[])],
        &[("general", &["old"], &["old"])],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    assert_eq!(
        channel_role(&app, space, "general", old).await.as_deref(),
        Some("member"),
        "the archive does not promote somebody who is in the channel already"
    );
}

#[tokio::test]
async fn an_adopted_channel_takes_new_moderators_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (old_email, new_email) = (address("old"), address("new"));
    let old = make_user_with(&app, &old_email).await;
    let (name, space) = space_with_general(&app, fx.alice, old).await;
    let dir = people_archive_with(
        2,
        &name,
        &[("old", &old_email), ("new", &new_email)],
        &[("old", "member", &[]), ("new", "member", &[])],
        &[("general", &["old", "new"], &["old", "new"])],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("the run completes");
    let new = account_of(&app, &new_email).await;
    assert_eq!(
        channel_role(&app, space, "general", old).await.as_deref(),
        Some("member")
    );
    assert_eq!(
        channel_role(&app, space, "general", new).await.as_deref(),
        Some("admin")
    );
}

#[tokio::test]
async fn the_plan_counts_the_moderators_the_run_writes() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (old_email, guest_email, listed_email, new_email) = (
        address("old"),
        address("existing-guest"),
        address("listed-guest"),
        address("new"),
    );
    let old = make_user_with(&app, &old_email).await;
    let (name, space) = space_with_general(&app, fx.alice, old).await;
    // Somebody who is a guest of the space already, whatever the archive lists them as.
    let existing_guest = make_user_with(&app, &guest_email).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(existing_guest),
        role: Set("guest".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("guest row");
    let dir = people_archive_with(
        2,
        &name,
        &[
            ("old", &old_email),
            ("eg", &guest_email),
            ("lg", &listed_email),
            ("new", &new_email),
        ],
        &[
            ("old", "member", &[]),
            ("eg", "member", &[]),
            ("lg", "guest", &[]),
            ("new", "member", &[]),
        ],
        &[(
            "general",
            &["old", "eg", "lg", "new"],
            &["old", "eg", "lg", "new"],
        )],
    );
    let edition: Arc<dyn Edition> = Arc::new(CommunityEdition);
    let (index, _) = crate::importer::check::check(&dir, None).expect("check");
    let existing = crate::importer::job::existing_for(&app.db, fx.alice, edition.as_ref())
        .await
        .expect("existing");
    let plan = crate::importer::plan::build(&index, &existing);
    let planned = crate::importer::plan::people_plan(&index, &plan, &existing).moderators;

    let (_, outcome) = run_people(&app, fx.alice, &dir, edition).await;
    let written = outcome.expect("the run completes").written.moderators;
    // `old` is in the adopted channel already, `eg` is a guest here, `lg` is listed a guest: only
    // `new` is written a moderator.
    assert_eq!(written, 1);
    assert_eq!(planned, written, "the plan counts what the run writes");
}

#[tokio::test]
async fn a_channel_only_person_still_arrives_member_and_takes_a_seat_check() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let (space_ref, user_ref) = (unique_ref("s"), unique_ref("u"));
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let email = address("u");
    let index = Index {
        channels: vec![source_channel(
            &unique_ref("c"),
            &space_ref,
            "channel",
            &[&user_ref],
        )],
        ..import_index(
            vec![source_user(&user_ref, &email)],
            vec![source_space(&space_ref, &name)],
        )
    };
    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan::build(&index, &Existing::default()))
        .await
        .expect("accounts");
    let (_, spaces) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");

    // One seat sold and the owner holds it: the person in the channel does not fit.
    let refused =
        run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice, &Seats(1)).await;
    assert!(
        matches!(refused, Err(RunError::SeatsFull { .. })),
        "{refused:?}"
    );
    let user = account_of(&app, &email).await;
    assert!(row_of(&app, space, user).await.is_none());

    // With a seat to spare, the same person arrives as a member.
    run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice, &Seats(2))
        .await
        .expect("conversations");
    assert_eq!(standing_of(&app, space, user).await, "member");
}

// --- groups and custom roles -------------------------------------------------------------------

/// An edition that creates custom roles for real, in every space, and sells plenty of seats.
struct RoleMaker;

#[async_trait::async_trait]
impl Edition for RoleMaker {
    fn name(&self) -> &'static str {
        "role-maker"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Enterprise {
            seats: 1000,
            valid_until: time::macros::datetime!(2037-12-31 0:00 UTC),
        })
    }

    async fn seat_check(
        &self,
        _db: &sea_orm::DatabaseTransaction,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> axum::Router<AppState> {
        axum::Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}

    async fn import_custom_role(
        &self,
        txn: &sea_orm::DatabaseTransaction,
        space_id: Uuid,
        role: &crate::edition::ImportedRole,
        _actor: Uuid,
    ) -> Result<crate::edition::ImportedRoleOutcome, sea_orm::DbErr> {
        let id = Uuid::new_v4();
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO space_roles (id, space_id, name, permissions) VALUES ($1, $2, $3, '{}')",
            [id.into(), space_id.into(), role.name.clone().into()],
        ))
        .await?;
        Ok(crate::edition::ImportedRoleOutcome::Created(id))
    }
}

async fn group_rows(
    app: &TestApp,
    space: Uuid,
) -> Vec<(Uuid, String, Option<String>, String, Option<String>)> {
    app.db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id, name::text AS name, description, source, imported_from \
             FROM space_groups WHERE space_id = $1 ORDER BY created_at, name",
            [space.into()],
        ))
        .await
        .expect("query")
        .iter()
        .map(|r| {
            (
                r.try_get("", "id").expect("id"),
                r.try_get("", "name").expect("name"),
                r.try_get("", "description").expect("description"),
                r.try_get("", "source").expect("source"),
                r.try_get("", "imported_from").expect("imported_from"),
            )
        })
        .collect()
}

#[tokio::test]
async fn groups_arrive_as_they_are_with_their_members_and_no_rights() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[],
        &[("g1", "Design", "Les pixels", &["a", "b"])],
        &[],
    );
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let outcome = outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let groups = group_rows(&app, space).await;
    assert_eq!(groups.len(), 1);
    let (id, group, description, source, imported_from) = &groups[0];
    assert_eq!(group, "Design");
    assert_eq!(description.as_deref(), Some("Les pixels"));
    assert_eq!(source, "manual");
    assert_eq!(
        imported_from.as_deref(),
        Some(format!("mattermost:{job}").as_str())
    );
    let members = count(&app, "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1 AND NOT is_manager", vec![(*id).into()]).await;
    assert_eq!(members, 2);
    let roles = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_group_roles WHERE group_id = $1",
        vec![(*id).into()],
    )
    .await;
    assert_eq!(roles, 0, "a group arrives with no rights");
    assert_eq!(outcome.written.people.groups, 1);
}

#[tokio::test]
async fn a_group_already_imported_is_filled_not_duplicated() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let first = people_archive_full(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    run_people(&app, fx.alice, &first, Arc::new(CommunityEdition))
        .await
        .1
        .expect("first");
    let space = space_named(&app, &name).await;
    let group = group_rows(&app, space).await[0].0;

    // The same archive again, as a later job: the group is found, not made again.
    let (_, second) = run_people(&app, fx.alice, &first, Arc::new(CommunityEdition)).await;
    let second = second.expect("second");
    let groups = group_rows(&app, space).await;
    assert_eq!(groups.len(), 1, "filled, not duplicated");
    assert_eq!(groups[0].0, group);
    assert_eq!(second.written.people.groups, 0);
    assert_eq!(second.written.people.groups_filled, 1);
    let members = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(members, 1, "a later job adds nobody to an existing group");
}

#[tokio::test]
async fn a_renamed_group_keeps_its_new_name() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a) = (unique_space(), address("a"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a)],
        &[("a", "member", &[])],
        &[],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("first");
    let space = space_named(&app, &name).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE space_groups SET name = 'Studio' WHERE space_id = $1",
            [space.into()],
        ))
        .await
        .expect("rename");
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("second");
    let groups = group_rows(&app, space).await;
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].1, "Studio");
}

#[tokio::test]
async fn a_group_name_clash_takes_the_source_in_brackets() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    for taken in ["design", "Design (Mattermost)"] {
        app.db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO space_groups (space_id, name) VALUES ($1, $2)",
                [space.into(), taken.into()],
            ))
            .await
            .expect("group");
    }
    let a = address("a");
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a)],
        &[("a", "member", &[])],
        &[],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("run");
    let names: Vec<String> = group_rows(&app, space)
        .await
        .into_iter()
        .map(|g| g.1)
        .collect();
    assert!(
        names.contains(&"Design (Mattermost) 2".to_owned()),
        "{names:?}"
    );
}

#[tokio::test]
async fn a_group_member_listed_nowhere_joins_as_member() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a) = (unique_space(), address("a"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a)],
        &[],
        &[],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("run");
    let space = space_named(&app, &name).await;
    let user = account_of(&app, &a).await;
    assert_eq!(standing_of(&app, space, user).await, "member");
    let group = group_rows(&app, space).await[0].0;
    let in_group = count(&app, "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1 AND user_id = $2", vec![group.into(), user.into()]).await;
    assert_eq!(in_group, 1);
}

#[tokio::test]
async fn a_group_with_a_skipped_member_leaves_them_out() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("keep"), address("skip"));
    let dir = people_archive_full(
        2,
        &name,
        &[("keep", &a), ("skip", &b)],
        &[],
        &[],
        &[("g1", "Design", "", &["keep", "skip"])],
        &[],
    );
    let users = std::fs::read_to_string(dir.join("users.jsonl")).expect("users");
    let skipped = users
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).expect("json"))
        .find(|u| u["display_name"] == "skip")
        .map(|u| u["id"].as_str().expect("id").to_owned())
        .expect("skip");
    let options = json!({"people": [{"source_id": skipped, "skip": true}]}).to_string();
    let job = run::start_job(&app.db, "mattermost", fx.alice, None, &options)
        .await
        .expect("job");
    execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(Arc::new(CommunityEdition)),
    )
    .await
    .expect("run");
    let space = space_named(&app, &name).await;
    let group = group_rows(&app, space).await[0].0;
    let members = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(members, 1);
    assert!(users::Entity::find()
        .filter(users::Column::Email.eq(b.as_str()))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
}

fn role_archive(
    name: &str,
    holder_role: &str,
    holder_roles: &[&str],
    based_on: &str,
    holder: &str,
) -> std::path::PathBuf {
    people_archive_full(
        2,
        name,
        &[("h", holder)],
        &[("h", holder_role, holder_roles)],
        &[],
        &[],
        &[("r1", "Comptable", based_on)],
    )
}

#[tokio::test]
async fn a_community_space_brings_a_custom_role_down_to_member() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, h) = (unique_space(), address("h"));
    let dir = role_archive(&name, "member", &["r1"], "member", &h);
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let people = outcome.expect("run").written.people;
    assert_eq!(people.custom_roles, 0);
    assert_eq!(
        people.fallbacks,
        vec![crate::importer::people::Fallback {
            space: name.clone(),
            role_name: "Comptable".into(),
            fixed: "member".into(),
            people: 1
        }]
    );
    let space = space_named(&app, &name).await;
    assert_eq!(
        standing_of(&app, space, account_of(&app, &h).await).await,
        "member"
    );
}

#[tokio::test]
async fn an_admin_based_fallback_raises_to_administrator_and_says_so() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, h) = (unique_space(), address("h"));
    let dir = role_archive(&name, "member", &["r1"], "admin", &h);
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let people = outcome.expect("run").written.people;
    assert_eq!(people.fallbacks[0].fixed, "admin");
    assert_eq!(
        people.administrators, 1,
        "the summary counts the raised person"
    );
    let space = space_named(&app, &name).await;
    assert_eq!(
        standing_of(&app, space, account_of(&app, &h).await).await,
        "admin"
    );
}

#[tokio::test]
async fn a_custom_role_guest_holder_ignores_the_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, h) = (unique_space(), address("h"));
    let dir = role_archive(&name, "guest", &["r1"], "admin", &h);
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(RoleMaker)).await;
    let people = outcome.expect("run").written.people;
    assert!(people.fallbacks.is_empty());
    assert_eq!(people.custom_roles, 0);
    let space = space_named(&app, &name).await;
    assert_eq!(
        standing_of(&app, space, account_of(&app, &h).await).await,
        "guest"
    );
    let made = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_roles WHERE space_id = $1 AND system_key IS NULL",
        vec![space.into()],
    )
    .await;
    assert_eq!(made, 0);
}

#[tokio::test]
async fn a_licensed_space_gets_the_role_through_the_edition() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, h) = (unique_space(), address("h"));
    let dir = role_archive(&name, "member", &["r1"], "member", &h);
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(RoleMaker)).await;
    let people = outcome.expect("run").written.people;
    assert_eq!(people.custom_roles, 1);
    assert!(people.fallbacks.is_empty());
    let space = space_named(&app, &name).await;
    let holder = account_of(&app, &h).await;
    let assigned = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_role_assignments a JOIN space_roles r ON r.id = a.role_id \
         WHERE a.space_id = $1 AND a.user_id = $2 AND r.name = 'Comptable'",
        vec![space.into(), holder.into()],
    )
    .await;
    assert_eq!(assigned, 1);
    let mapped = count(
        &app,
        "SELECT count(*)::bigint AS n FROM import_mappings WHERE job_id = $1 AND kind = 'role' AND external_ref = 'r1'",
        vec![job.into()],
    )
    .await;
    assert_eq!(mapped, 1);
    // Run again: the role is found by its mapping, not asked for twice.
    run_people(&app, fx.alice, &dir, Arc::new(RoleMaker))
        .await
        .1
        .expect("second");
    let made = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_roles WHERE space_id = $1 AND name = 'Comptable'",
        vec![space.into()],
    )
    .await;
    assert_eq!(made, 1);
}

#[tokio::test]
async fn an_existing_member_is_never_given_a_custom_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (h, name) = (address("h"), unique_space());
    let holder = make_user_with(&app, &h).await;
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(holder),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let dir = role_archive(&name, "member", &["r1"], "admin", &h);
    let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(RoleMaker)).await;
    let people = outcome.expect("run").written.people;
    assert_eq!(people.custom_roles, 0);
    assert_eq!(standing_of(&app, space, holder).await, "member");
    let assigned = count(&app, "SELECT count(*)::bigint AS n FROM space_role_assignments WHERE space_id = $1 AND user_id = $2 AND role_id IN (SELECT id FROM space_roles WHERE system_key IS NULL)", vec![space.into(), holder.into()]).await;
    assert_eq!(assigned, 0);
}

// --- what an administrator decided stands --------------------------------------------------------

#[tokio::test]
async fn an_ended_guest_is_not_added_to_an_imported_group() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let (gone_email, here) = (address("gone"), address("here"));
    let gone = make_user_with(&app, &gone_email).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO space_members (space_id, user_id, role, expires_at) \
             VALUES ($1, $2, 'guest', now() - interval '1 day')",
            [space.into(), gone.into()],
        ))
        .await
        .expect("ended guest");
    let dir = people_archive_full(
        2,
        &name,
        &[("gone", &gone_email), ("here", &here)],
        &[("here", "member", &[])],
        &[],
        &[("g1", "Design", "", &["gone", "here"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("run");
    let group = group_rows(&app, space).await[0].0;
    let in_group = count(&app, "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1 AND user_id = $2", vec![group.into(), gone.into()]).await;
    assert_eq!(
        in_group, 0,
        "an ended guest is out of the space, so out of its groups"
    );
    let total = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(total, 1);
}

#[tokio::test]
async fn a_resume_of_the_same_job_counts_its_group_as_created_and_fills_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a) = (unique_space(), address("a"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a)],
        &[("a", "member", &[])],
        &[],
        &[("g1", "Design", "", &["a"])],
        &[],
    );
    let (job, first) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    first.expect("first");
    let space = space_named(&app, &name).await;
    let group = group_rows(&app, space).await[0].0;
    // Somebody leaves the group, then the SAME job resumes: its own group is refilled.
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM space_group_members WHERE group_id = $1",
            [group.into()],
        ))
        .await
        .expect("empty it");
    let resumed = execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(Arc::new(CommunityEdition)),
    )
    .await
    .expect("resume");
    assert_eq!(resumed.written.people.groups, 1);
    assert_eq!(resumed.written.people.groups_filled, 0);
    let members = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(members, 1);
}

#[tokio::test]
async fn a_later_job_leaves_an_imported_groups_members_as_they_are() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "member", &[]), ("b", "member", &[])],
        &[],
        &[("g1", "Design", "", &["a", "b"])],
        &[],
    );
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("first");
    let space = space_named(&app, &name).await;
    let group = group_rows(&app, space).await[0].0;
    let b_id = account_of(&app, &b).await;
    // An administrator takes b out of the group.
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM space_group_members WHERE group_id = $1 AND user_id = $2",
            [group.into(), b_id.into()],
        ))
        .await
        .expect("remove");
    let (_, second) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let second = second.expect("second");
    assert_eq!(second.written.people.groups_filled, 1);
    let still_in = count(&app, "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1 AND user_id = $2", vec![group.into(), b_id.into()]).await;
    assert_eq!(still_in, 0, "a re-run does not put them back");
}

#[tokio::test]
async fn a_resume_does_not_raise_again_someone_an_administrator_demoted() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let squatter = make_user_with(&app, &address("sq")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(squatter),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let (h1, h2) = (address("h1"), address("h2"));
    let dir = people_archive_full(
        2,
        &name,
        &[("h1", &h1), ("h2", &h2)],
        &[("h1", "member", &["r1"]), ("h2", "member", &["r1"])],
        &[],
        &[],
        &[("r1", "Comptable", "admin")],
    );
    // Owner and squatter use two of three seats: h1 fits (and is raised by the fallback), h2 does not.
    let (job, first) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    assert!(matches!(first, Err(RunError::SeatsFull { .. })));
    let h1_id = account_of(&app, &h1).await;
    assert_eq!(standing_of(&app, space, h1_id).await, "admin");
    // An administrator demotes h1 during the pause and frees a seat; the same job resumes.
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = $2",
            [space.into(), h1_id.into()],
        ))
        .await
        .expect("demote");
    space_members::Entity::delete_by_id((space, squatter))
        .exec(&app.db)
        .await
        .expect("free");
    execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(Arc::new(Seats(3))),
    )
    .await
    .expect("resume");
    assert_eq!(
        standing_of(&app, space, h1_id).await,
        "member",
        "the demotion stands"
    );
    assert_eq!(
        standing_of(&app, space, account_of(&app, &h2).await).await,
        "admin",
        "h2 is raised now"
    );
}

#[tokio::test]
async fn the_same_role_name_in_two_spaces_gives_two_fallback_lines() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (first, second, h) = (unique_space(), unique_space(), address("h"));
    let mut lines = Vec::new();
    for name in [&first, &second] {
        let dir = role_archive(name, "member", &["r1"], "member", &h);
        let (_, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
        lines.extend(outcome.expect("run").written.people.fallbacks);
    }
    assert_eq!(lines.len(), 2);
    assert_ne!(lines[0].space, lines[1].space);
    assert_eq!(lines[0].role_name, lines[1].role_name);
}

// --- what crossed, the journal line, the job response -----------------------------------------

async fn journal(app: &TestApp, space: Uuid) -> Vec<(String, Option<Uuid>, Value)> {
    app.db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT action, actor_id, details FROM space_audit_log \
             WHERE space_id = $1 AND action = 'import.applied' ORDER BY at",
            [space.into()],
        ))
        .await
        .expect("query")
        .iter()
        .map(|r| {
            (
                r.try_get("", "action").expect("action"),
                r.try_get("", "actor_id").expect("actor"),
                r.try_get("", "details").expect("details"),
            )
        })
        .collect()
}

/// An archive with an administrator, a guest, two members, a group and a role, in a new space.
fn crossing_archive(name: &str, based_on: &str) -> std::path::PathBuf {
    let emails: Vec<String> = ["a", "b", "c", "d"].iter().map(|n| address(n)).collect();
    people_archive_full(
        2,
        name,
        &[
            ("a", &emails[0]),
            ("b", &emails[1]),
            ("c", &emails[2]),
            ("d", &emails[3]),
        ],
        &[
            ("a", "admin", &[]),
            ("b", "guest", &[]),
            ("c", "member", &["r1"]),
            ("d", "member", &[]),
        ],
        &[("general", &["a", "c", "d"], &["a"])],
        &[("g1", "Design", "", &["c", "d"])],
        &[("r1", "Comptable", based_on)],
    )
}

async fn get_job(app: &TestApp, cookie: &str, job: Uuid) -> Value {
    app.req(
        reqwest::Method::GET,
        &format!("/api/v1/imports/{job}"),
        cookie,
    )
    .send()
    .await
    .expect("request")
    .json()
    .await
    .expect("json")
}

#[tokio::test]
async fn the_job_carries_what_crossed_and_the_limits_again() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let dir = crossing_archive(&name, "admin");
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let cookie = app.cookie_for(fx.alice).await;
    let body = get_job(&app, &cookie, job).await;
    let people = &body["people"];
    // Administrators: a, plus c raised by the admin-based role that could not be created.
    assert_eq!(people["administrators"], 2);
    assert_eq!(people["guests"], 1);
    assert_eq!(people["moderators"], 1);
    assert_eq!(people["groups"], 1);
    assert_eq!(people["group_names"], json!(["Design"]));
    assert_eq!(people["kept"], 0);
    assert_eq!(people["custom_roles"], 0);
    assert_eq!(
        people["fallbacks"],
        json!([{"space": name, "role_name": "Comptable", "fixed": "admin", "people": 1}])
    );
    assert_eq!(body["limits"], json!(["nothing in particular"]));
}

#[tokio::test]
async fn the_summary_survives_a_reload_of_the_job() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let dir = crossing_archive(&unique_space(), "member");
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let stored = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert!(
        stored.summary.is_some(),
        "kept on the row, not only in memory"
    );
    let cookie = app.cookie_for(fx.alice).await;
    let (first, second) = (
        get_job(&app, &cookie, job).await,
        get_job(&app, &cookie, job).await,
    );
    assert_eq!(first["people"], second["people"]);
    assert_eq!(first["people"]["fallbacks"][0]["fixed"], "member");
}

#[tokio::test]
async fn one_journal_line_per_import_and_space_naming_the_job() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let dir = crossing_archive(&name, "member");
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let lines = journal(&app, space).await;
    assert_eq!(lines.len(), 1, "four people, one line: {lines:?}");
    let (action, actor, details) = &lines[0];
    assert_eq!(action, "import.applied");
    assert_eq!(*actor, Some(fx.alice));
    assert_eq!(details["source"], "mattermost");
    assert_eq!(details["job_id"], job.to_string());
    assert_eq!(details["administrators"], 1);
    assert_eq!(details["guests"], 1);
    assert_eq!(details["groups"], 1);
    assert_eq!(details["moderators"], 1);
    assert_eq!(details["custom_roles"], 0);
    assert_eq!(details["fallbacks"], 1);
    assert_eq!(crate::audit::Action::ImportApplied.category(), "members");
}

#[tokio::test]
async fn a_resumed_run_writes_no_empty_journal_line() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let dir = crossing_archive(&name, "member");
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("first");
    let space = space_named(&app, &name).await;
    assert_eq!(journal(&app, space).await.len(), 1);
    // The same archive again: everybody is there already, nothing is new.
    run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition))
        .await
        .1
        .expect("second");
    assert_eq!(
        journal(&app, space).await.len(),
        1,
        "no line for a run that changed nothing"
    );
}

#[tokio::test]
async fn imported_from_is_shown_to_managers_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (a, c) = (address("a"), address("c"));
    let dir = people_archive_full(
        2,
        &name,
        &[("a", &a), ("c", &c)],
        &[("a", "admin", &[]), ("c", "member", &[])],
        &[("general", &["a", "c"], &[])],
        &[("g1", "Design", "", &["c"])],
        &[],
    );
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let space = space_named(&app, &name).await;
    let c_id = account_of(&app, &c).await;
    let wanted = format!("mattermost:{job}");

    let members_as = |cookie: String| {
        let app = &app;
        async move {
            let list: Value = app
                .req(
                    reqwest::Method::GET,
                    &format!("/api/v1/spaces/{space}/members"),
                    &cookie,
                )
                .send()
                .await
                .expect("request")
                .json()
                .await
                .expect("json");
            list.as_array()
                .expect("a list")
                .iter()
                .find(|m| m["user_id"] == c_id.to_string())
                .cloned()
                .expect("c is listed")
        }
    };
    let manager = members_as(app.cookie_for(fx.alice).await).await;
    assert_eq!(manager["imported_from"], wanted.as_str());
    let plain = members_as(app.cookie_for(c_id).await).await;
    assert!(plain.get("imported_from").is_none(), "{plain}");

    let seen_by_plain: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/groups"),
            &app.cookie_for(c_id).await,
        )
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("json");
    assert!(
        seen_by_plain[0].get("imported_from").is_none(),
        "{seen_by_plain}"
    );
    let groups: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/groups"),
            &app.cookie_for(fx.alice).await,
        )
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("json");
    assert_eq!(groups[0]["imported_from"], wanted.as_str());
}

// --- one write per person, and a stopped run keeps its record ------------------------------------

/// [`RoleMaker`] whose first `import_custom_role` fails, as a database error would.
struct Flaky {
    fail_next: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl Edition for Flaky {
    fn name(&self) -> &'static str {
        "flaky"
    }

    async fn entitlement(
        &self,
        db: &DatabaseConnection,
        space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        RoleMaker.entitlement(db, space_id).await
    }

    async fn seat_check(
        &self,
        db: &sea_orm::DatabaseTransaction,
        space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        RoleMaker.seat_check(db, space_id).await
    }

    fn routes(&self) -> axum::Router<AppState> {
        axum::Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}

    async fn import_custom_role(
        &self,
        txn: &sea_orm::DatabaseTransaction,
        space_id: Uuid,
        role: &crate::edition::ImportedRole,
        actor: Uuid,
    ) -> Result<crate::edition::ImportedRoleOutcome, sea_orm::DbErr> {
        if self
            .fail_next
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(sea_orm::DbErr::Custom("the role write failed".to_owned()));
        }
        RoleMaker
            .import_custom_role(txn, space_id, role, actor)
            .await
    }
}

#[tokio::test]
async fn a_person_arrives_with_their_roles_or_not_at_all() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, h) = (unique_space(), address("h"));
    let dir = role_archive(&name, "member", &["r1"], "member", &h);
    let edition: Arc<dyn Edition> = Arc::new(Flaky {
        fail_next: std::sync::atomic::AtomicBool::new(true),
    });
    let (job, first) = run_people(&app, fx.alice, &dir, edition.clone()).await;
    assert!(first.is_err(), "the role write failed once");
    let space = space_named(&app, &name).await;
    let holder = account_of(&app, &h).await;
    assert!(
        row_of(&app, space, holder).await.is_none(),
        "no member row without the role that goes with it"
    );

    // The same job resumes: the person is admitted with the role in one write.
    execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(edition),
    )
    .await
    .expect("the resume completes");
    assert_eq!(standing_of(&app, space, holder).await, "member");
    let assigned = count(
        &app,
        "SELECT count(*)::bigint AS n FROM space_role_assignments a JOIN space_roles r ON r.id = a.role_id \
         WHERE a.space_id = $1 AND a.user_id = $2 AND r.name = 'Comptable'",
        vec![space.into(), holder.into()],
    )
    .await;
    assert_eq!(assigned, 1);
}

#[tokio::test]
async fn a_run_that_stops_keeps_its_summary_and_its_journal_line() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let squatter = make_user_with(&app, &address("sq")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(squatter),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let (a, b) = (address("a"), address("b"));
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "admin", &[]), ("b", "member", &[])],
        &[],
    );
    // Owner and squatter use two of three seats: the administrator fits, the member does not.
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    assert!(matches!(outcome, Err(RunError::SeatsFull { .. })));
    let stored = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(stored.status, "failed");
    let summary = stored.summary.expect("what the run did before it stopped");
    assert_eq!(summary["administrators"], 1);
    let lines = journal(&app, space).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].2["administrators"], 1);
    assert_eq!(lines[0].2["job_id"], job.to_string());
}

#[tokio::test]
async fn saving_twice_writes_one_journal_line_per_job_and_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a) = (unique_space(), address("a"));
    let dir = people_archive(2, &name, &[("a", &a)], &[("a", "admin", &[])], &[]);
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    let people = outcome.expect("run").written.people;
    let space = space_named(&app, &name).await;
    crate::importer::summary::save(
        &app.db,
        &CommunityEdition,
        job,
        fx.alice,
        "mattermost",
        1,
        &people,
    )
    .await
    .expect("a retry of the same attempt");
    assert_eq!(journal(&app, space).await.len(), 1);
}

#[tokio::test]
async fn a_resumed_run_journals_what_it_added() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let (space, _) = crate::messaging::spaces::create_owned_space(&app.db, &name, fx.alice)
        .await
        .expect("space");
    let squatter = make_user_with(&app, &address("sq")).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(squatter),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let (a, b) = (address("a"), address("b"));
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "admin", &[]), ("b", "admin", &[])],
        &[],
    );
    // Owner and squatter use two of three seats: the first administrator fits, the second does not.
    let (job, first) = run_people(&app, fx.alice, &dir, Arc::new(Seats(3))).await;
    assert!(matches!(first, Err(RunError::SeatsFull { .. })));
    space_members::Entity::delete_by_id((space, squatter))
        .exec(&app.db)
        .await
        .expect("free a seat");
    execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        settings(Arc::new(Seats(3))),
    )
    .await
    .expect("the resume completes");

    let lines = journal(&app, space).await;
    assert_eq!(lines.len(), 2, "one line per attempt: {lines:?}");
    let in_lines: i64 = lines
        .iter()
        .map(|(_, _, details)| details["administrators"].as_i64().expect("count"))
        .sum();
    let stored = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    let summary = stored.summary.expect("summary");
    assert_eq!(in_lines, summary["administrators"].as_i64().expect("count"));
    assert_eq!(in_lines, 2);
}

#[tokio::test]
async fn a_job_response_names_who_started_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let dir = crossing_archive(&unique_space(), "member");
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let alice = users::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("user");
    let cookie = app.cookie_for(fx.alice).await;
    let body = get_job(&app, &cookie, job).await;
    assert_eq!(body["started_by"]["id"], fx.alice.to_string());
    assert_eq!(body["started_by"]["name"], alice.display_name);

    // The account is gone: the job stays, and says nobody rather than a stale name.
    let mut stored: crate::entities::import_jobs::ActiveModel =
        crate::entities::import_jobs::Entity::find_by_id(job)
            .one(&app.db)
            .await
            .expect("query")
            .expect("job")
            .into();
    stored.created_by = Set(None);
    stored.update(&app.db).await.expect("detach");
    let body = get_job(&app, &cookie, job).await;
    assert!(body["started_by"].is_null(), "{body}");
}

#[tokio::test]
async fn the_summary_lists_the_spaces_the_run_created() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let name = unique_space();
    let dir = crossing_archive(&name, "member");
    let (job, outcome) = run_people(&app, fx.alice, &dir, Arc::new(CommunityEdition)).await;
    outcome.expect("the run completes");
    let cookie = app.cookie_for(fx.alice).await;
    let body = get_job(&app, &cookie, job).await;
    assert_eq!(body["people"]["created_spaces"], json!([name]));
}
