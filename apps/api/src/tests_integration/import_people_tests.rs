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
    app: TestApp,
    admin: String,
    /// The name of an archive in the import directory that fills the seeded space with `new`
    /// people who are not here yet.
    archive: String,
    space_name: String,
    alice: Uuid,
}

/// A licensed instance of `seats` per space, whose seeded "Test Space" holds three members, and an
/// archive filling that space with `new` accounts nobody has met.
async fn harness(seats: u32, new: usize) -> Option<Harness> {
    let dir = std::env::temp_dir().join(format!("ruchoir-people-plan-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("import dir");
    let place = dir.clone();
    let app = boot_as(Arc::new(Seats(seats)), None, move |c| {
        c.import_dir = Some(place);
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
        app,
        admin: admin_cookie,
        archive: name,
        space_name,
        alice: fx.alice,
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

    /// Jobs this administrator started: the shared database holds everyone else's.
    async fn jobs(&self) -> u64 {
        use sea_orm::PaginatorTrait;
        crate::entities::import_jobs::Entity::find()
            .filter(crate::entities::import_jobs::Column::CreatedBy.eq(self.alice))
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
    assert_eq!(h.jobs().await, before, "no job row for a refused start");
}

#[tokio::test]
async fn start_accepts_when_the_seats_just_fit() {
    // Three used, four coming, seven sold.
    let Some(h) = harness(7, 4).await else {
        return;
    };
    let response = h.call("/api/v1/imports").await;
    // 409 when another test of the shared database has an import open: what matters here is that
    // the seats did not refuse it.
    assert!(
        matches!(response.status().as_u16(), 202 | 409),
        "{}",
        response.status()
    );
    assert_ne!(response.status(), 402);
}
