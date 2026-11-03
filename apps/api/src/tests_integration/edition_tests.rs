//! The edition the server runs as: what a build made elsewhere plugs in (routes, features), and
//! that the community build plugs in nothing. Same harness as the parent module, same skip rule.

use super::*;

use axum::routing::get;
use axum::Router;

use crate::edition::{CommunityEdition, Edition, Entitlement, SeatCheck};

/// An edition that brings one route and one feature, to see both arrive.
struct ProbeEdition;

#[async_trait::async_trait]
impl Edition for ProbeEdition {
    fn name(&self) -> &'static str {
        "probe"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Community)
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> Router<AppState> {
        Router::new().route("/api/v1/probe", get(|| async { "probed" }))
    }

    fn features(&self) -> &'static [&'static str] {
        &["probe"]
    }

    fn background(&self, _state: AppState) {}
}

async fn instance_of(app: &TestApp) -> Value {
    app.http
        .get(format!("{}/api/v1/instance", app.base))
        .send()
        .await
        .expect("instance")
        .json()
        .await
        .expect("json")
}

async fn features_of(app: &TestApp) -> Vec<String> {
    let body = instance_of(app).await;
    body["features"]
        .as_array()
        .expect("features")
        .iter()
        .map(|f| f.as_str().expect("name").to_owned())
        .collect()
}

#[tokio::test]
async fn an_edition_adds_its_routes_and_its_features() {
    let Some(app) = boot_as(Arc::new(ProbeEdition), None, |_| {}).await else {
        return;
    };
    let features = features_of(&app).await;
    assert!(features.contains(&"probe".to_owned()), "{features:?}");
    // Where a screen offering a paid feature sends people: the configured page, the site's by
    // default.
    assert_eq!(
        instance_of(&app).await["pricing_url"],
        app.config.pricing_url.as_str()
    );
    // The edition's names come after the instance's own, which are all still there.
    for own in crate::compat::FEATURES {
        assert!(features.contains(&(*own).to_owned()), "{own} missing");
    }
    let probe = app
        .http
        .get(format!("{}/api/v1/probe", app.base))
        .send()
        .await
        .expect("probe");
    assert_eq!(probe.status(), 200);
    assert_eq!(probe.text().await.expect("body"), "probed");
    assert_eq!(app.state.edition.name(), "probe");
}

#[tokio::test]
async fn the_community_edition_changes_nothing() {
    let Some(app) = boot().await else { return };
    assert_eq!(app.state.edition.name(), CommunityEdition.name());
    let features = features_of(&app).await;
    assert_eq!(
        features,
        crate::compat::FEATURES
            .iter()
            .map(|f| (*f).to_owned())
            .collect::<Vec<_>>()
    );
    let probe = app
        .http
        .get(format!("{}/api/v1/probe", app.base))
        .send()
        .await
        .expect("probe");
    assert_eq!(probe.status(), 404);
    let space = Uuid::new_v4();
    assert_eq!(
        CommunityEdition
            .entitlement(&app.db, space)
            .await
            .expect("entitlement"),
        Entitlement::Community
    );
    assert_eq!(
        CommunityEdition
            .seat_check(&app.db, space)
            .await
            .expect("seats"),
        SeatCheck::Allowed
    );
}

/// The end of 2027, the licences below run until.
const END_OF_2027: OffsetDateTime = time::macros::datetime!(2027-12-31 0:00 UTC);

/// An edition entitling every space to 25 seats until the end of 2027.
struct LicensedEdition;

#[async_trait::async_trait]
impl Edition for LicensedEdition {
    fn name(&self) -> &'static str {
        "licensed"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Enterprise {
            seats: 25,
            valid_until: END_OF_2027,
        })
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> Router<AppState> {
        Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

/// An edition whose every space's licence (25 seats) ran out at the start of 2026.
struct FrozenEdition;

#[async_trait::async_trait]
impl Edition for FrozenEdition {
    fn name(&self) -> &'static str {
        "frozen"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Frozen {
            seats: 25,
            expired_at: time::macros::datetime!(2026-01-01 0:00 UTC),
        })
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> Router<AppState> {
        Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

/// An owner, a member and a guest in a new space.
async fn three_standings(db: &DatabaseConnection) -> (Uuid, Uuid, Uuid, Uuid) {
    let owner = make_user(db, "owner").await;
    let member = make_user(db, "member").await;
    let guest = make_user(db, "guest").await;
    let space = crate::testkit::make_space(db, owner, "Edition").await;
    crate::testkit::add_member(db, space, member, "member").await;
    crate::testkit::add_member(db, space, guest, "guest").await;
    (space, owner, member, guest)
}

#[tokio::test]
async fn a_space_says_its_edition() {
    // Community: every member reads `community`, and nobody is shown a licence.
    let Some(app) = boot().await else { return };
    let (space, owner, member, _) = three_standings(&app.db).await;
    for person in [owner, member] {
        let cookie = app.cookie_for(person).await;
        let row = space_row(&app, &cookie, space).await;
        assert_eq!(row["edition"], "community");
        assert!(row.get("licence").is_none(), "{row}");
    }

    // Licensed: everyone reads `enterprise`; the owner alone reads the seats (guests take none).
    let Some(app) = boot_as(Arc::new(LicensedEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, member, guest) = three_standings(&app.db).await;
    let row = space_row(&app, &app.cookie_for(owner).await, space).await;
    assert_eq!(row["edition"], "enterprise");
    assert_eq!(row["licence"]["seats"], 25);
    assert_eq!(row["licence"]["used"], 2);
    assert_eq!(row["licence"]["valid_until"], "2027-12-31T00:00:00Z");
    assert!(row["licence"]["expires_in_days"].as_i64().expect("days") > 0);
    for person in [member, guest] {
        let row = space_row(&app, &app.cookie_for(person).await, space).await;
        assert_eq!(row["edition"], "enterprise");
        assert!(row.get("licence").is_none(), "{row}");
    }

    // Frozen: the owner still reads the seats, and no day left.
    let Some(app) = boot_as(Arc::new(FrozenEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, member, _) = three_standings(&app.db).await;
    let row = space_row(&app, &app.cookie_for(owner).await, space).await;
    assert_eq!(row["edition"], "frozen");
    assert_eq!(row["licence"]["seats"], 25);
    assert_eq!(row["licence"]["valid_until"], "2026-01-01T00:00:00Z");
    assert_eq!(row["licence"]["expires_in_days"], 0);
    let row = space_row(&app, &app.cookie_for(member).await, space).await;
    assert_eq!(row["edition"], "frozen");
    assert!(row.get("licence").is_none(), "{row}");
}

#[tokio::test]
async fn a_community_build_reads_licensed_spaces_as_community() {
    let Some(app) = boot().await else { return };
    let (space, owner, member, _) = three_standings(&app.db).await;
    // What a licensed build left behind: its licence, and a fine rule on a channel.
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO space_licences (space_id, licence, licence_id, organisation, seats, \
             valid_until, installed_by) VALUES ($1, 'RUCHOIR-LICENCE-1.x.y', $2, 'Atelier', 25, \
             $3, $4)",
            [
                space.into(),
                Uuid::new_v4().into(),
                END_OF_2027.into(),
                owner.into(),
            ],
        ))
        .await
        .expect("licence row");
    let channel = make_channel(&app.db, space, "annonces", "public").await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO permission_overrides (space_id, channel_id, user_id, deny) \
             VALUES ($1, $2, $3, ARRAY['message.send'])",
            [space.into(), channel.into(), member.into()],
        ))
        .await
        .expect("rule");

    let row = space_row(&app, &app.cookie_for(owner).await, space).await;
    assert_eq!(row["edition"], "community");
    assert!(row.get("licence").is_none(), "{row}");
    let licence = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/licence"),
            &app.cookie_for(owner).await,
        )
        .send()
        .await
        .expect("licence route");
    assert_eq!(licence.status(), 404);
    // The rule keeps applying: a deny that disappeared would be an access that appeared.
    use crate::permissions::catalogue::Permission;
    use crate::permissions::check::{can, Resource};
    assert!(!can(
        &app.db,
        space,
        member,
        Resource::Channel(channel),
        Permission::MessageSend
    )
    .await
    .expect("can"));
    assert!(can(
        &app.db,
        space,
        member,
        Resource::Channel(channel),
        Permission::MessageReact
    )
    .await
    .expect("can"));
}

/// An edition whose every space has all of its 7 seats taken.
struct FullEdition;

#[async_trait::async_trait]
impl Edition for FullEdition {
    fn name(&self) -> &'static str {
        "full"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(Entitlement::Enterprise {
            seats: 7,
            valid_until: END_OF_2027,
        })
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Full { seats: 7 })
    }

    fn routes(&self) -> Router<AppState> {
        Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

async fn invite(app: &TestApp, cookie: &str, space: Uuid, role: &str) -> reqwest::Response {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/spaces/{space}/invitations"),
        cookie,
    )
    .json(&json!({ "role": role }))
    .send()
    .await
    .expect("invite")
}

#[tokio::test]
async fn a_full_space_refuses_a_member_invitation_with_the_pricing_link() {
    let Some(app) = boot_as(Arc::new(FullEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, _, _) = three_standings(&app.db).await;
    let cookie = app.cookie_for(owner).await;
    for role in ["member", "admin"] {
        let refused = invite(&app, &cookie, space, role).await;
        assert_eq!(refused.status(), 402, "{role}");
        let body: Value = refused.json().await.expect("json");
        assert_eq!(body["error"], "seats_full");
        assert_eq!(body["seats"], 7);
        assert_eq!(body["pricing_url"], app.config.pricing_url.as_str());
    }
    assert_eq!(app.config.pricing_url, "https://ruchoir.com/");
}

#[tokio::test]
async fn a_full_space_still_takes_a_guest() {
    let Some(app) = boot_as(Arc::new(FullEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, _, _) = three_standings(&app.db).await;
    let created = invite(&app, &app.cookie_for(owner).await, space, "guest").await;
    assert_eq!(created.status(), 201);
    let url = created.json::<Value>().await.expect("json")["url"]
        .as_str()
        .expect("url")
        .to_owned();
    let newcomer = make_user(&app.db, "newcomer").await;
    let accepted = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{}/accept", token_of(&url)),
            &app.cookie_for(newcomer).await,
        )
        .send()
        .await
        .expect("accept");
    assert_eq!(accepted.status(), 200);
    assert_eq!(role_of(&app.db, space, newcomer).await, "guest");
}

#[tokio::test]
async fn a_full_space_still_lets_someone_be_removed() {
    let Some(app) = boot_as(Arc::new(FullEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, member, guest) = three_standings(&app.db).await;
    let cookie = app.cookie_for(owner).await;
    for person in [member, guest] {
        let removed = app
            .req(
                reqwest::Method::DELETE,
                &format!("/api/v1/spaces/{space}/members/{person}"),
                &cookie,
            )
            .send()
            .await
            .expect("remove");
        assert!(removed.status().is_success(), "{}", removed.status());
    }
}

#[tokio::test]
async fn accepting_a_member_invitation_into_a_full_space_is_refused() {
    // Issued while there was room (a community server on the same database), accepted once the
    // space is full.
    let Some(roomy) = boot().await else { return };
    let (space, owner, _, _) = three_standings(&roomy.db).await;
    let created = invite(&roomy, &roomy.cookie_for(owner).await, space, "member").await;
    assert_eq!(created.status(), 201);
    let url = created.json::<Value>().await.expect("json")["url"]
        .as_str()
        .expect("url")
        .to_owned();

    let Some(app) = boot_as(Arc::new(FullEdition), None, |_| {}).await else {
        return;
    };
    let newcomer = make_user(&app.db, "newcomer").await;
    let refused = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{}/accept", token_of(&url)),
            &app.cookie_for(newcomer).await,
        )
        .send()
        .await
        .expect("accept");
    assert_eq!(refused.status(), 402);
    assert_eq!(
        refused.json::<Value>().await.expect("json")["error"],
        "seats_full"
    );
    assert!(space_members::Entity::find_by_id((space, newcomer))
        .one(&app.db)
        .await
        .expect("lookup")
        .is_none());
}

#[tokio::test]
async fn turning_a_guest_into_a_member_of_a_full_space_is_refused() {
    let Some(app) = boot_as(Arc::new(FullEdition), None, |_| {}).await else {
        return;
    };
    let (space, owner, member, guest) = three_standings(&app.db).await;
    let cookie = app.cookie_for(owner).await;
    let change = |person: Uuid, role: &'static str| {
        app.req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space}/members/{person}"),
            &cookie,
        )
        .json(&json!({ "role": role }))
        .send()
    };
    for role in ["member", "admin"] {
        let refused = change(guest, role).await.expect("change");
        assert_eq!(refused.status(), 402, "{role}");
    }
    assert_eq!(role_of(&app.db, space, guest).await, "guest");
    // A member already holds a seat: raising them takes no other one.
    let raised = change(member, "admin").await.expect("change");
    assert_eq!(raised.status(), 200);
    assert_eq!(role_of(&app.db, space, member).await, "admin");
}

/// An edition with a fixed entitlement for every space and one paid route behind the core's gate.
struct GatedEdition(Entitlement);

#[async_trait::async_trait]
impl Edition for GatedEdition {
    fn name(&self) -> &'static str {
        "gated"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(self.0)
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Allowed)
    }

    fn routes(&self) -> Router<AppState> {
        use axum::extract::{Path, State};
        Router::new().route(
            "/api/v1/spaces/{space_id}/paid-probe",
            axum::routing::post(
                |State(state): State<AppState>, Path(space_id): Path<Uuid>| async move {
                    crate::ext::ensure_paid(&state, space_id).await?;
                    Ok::<_, crate::ext::ApiError>("written")
                },
            ),
        )
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

#[tokio::test]
async fn a_paid_write_needs_a_licence() {
    for (entitlement, status, error) in [
        (Entitlement::Community, 402, Some("licence_required")),
        (
            Entitlement::Frozen {
                seats: 25,
                expired_at: time::macros::datetime!(2026-01-01 0:00 UTC),
            },
            409,
            Some("licence_frozen"),
        ),
        (
            Entitlement::Enterprise {
                seats: 25,
                valid_until: END_OF_2027,
            },
            200,
            None,
        ),
    ] {
        let Some(app) = boot_as(Arc::new(GatedEdition(entitlement)), None, |_| {}).await else {
            return;
        };
        let response = app
            .http
            .post(format!(
                "{}/api/v1/spaces/{}/paid-probe",
                app.base,
                Uuid::new_v4()
            ))
            .send()
            .await
            .expect("probe");
        assert_eq!(response.status(), status, "{entitlement:?}");
        if let Some(error) = error {
            let body: Value = response.json().await.expect("json");
            assert_eq!(body["error"], error);
            if error == "licence_required" {
                assert_eq!(body["pricing_url"], app.config.pricing_url.as_str());
            }
        }
    }
}
