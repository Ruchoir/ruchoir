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
            .map(|(name, people)| {
                let people: Vec<String> = people.iter().map(|p| q(p)).collect();
                json!({"id": q(name), "space": space_ref, "kind": "channel", "name": name,
                       "visibility": "public", "members": people})
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
async fn a_rerun_changes_no_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    become_admin(&app, fx.alice).await;
    let (name, a, b) = (unique_space(), address("a"), address("b"));
    let dir = people_archive(
        2,
        &name,
        &[("a", &a), ("b", &b)],
        &[("a", "admin", &[]), ("b", "guest", &[])],
        &[("general", &["a", "b"])],
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
