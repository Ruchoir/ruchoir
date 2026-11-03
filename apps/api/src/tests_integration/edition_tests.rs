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

async fn features_of(app: &TestApp) -> Vec<String> {
    let body: Value = app
        .http
        .get(format!("{}/api/v1/instance", app.base))
        .send()
        .await
        .expect("instance")
        .json()
        .await
        .expect("json");
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
    let channel = make_channel(&app.db, space, "general", "public").await;
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
