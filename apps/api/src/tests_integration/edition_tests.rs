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
