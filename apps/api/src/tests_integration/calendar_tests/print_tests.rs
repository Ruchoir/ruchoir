//! Printing: each view as a PDF, for the person signed in only.

use super::*;

async fn print(app: &TestApp, cookie: &str, query: &str) -> reqwest::Response {
    app.req(
        reqwest::Method::GET,
        &format!("/api/v1/calendar/print?{query}"),
        cookie,
    )
    .send()
    .await
    .expect("print")
}

#[tokio::test]
async fn each_view_prints_as_a_pdf_to_download() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    assert_eq!(
        create_event(
            &app,
            &alice,
            &general["id"],
            weekly_meeting("Point #1 *équipe*")
        )
        .await
        .status(),
        201
    );
    for view in ["day", "week", "month", "list", "year"] {
        let response = print(
            &app,
            &alice,
            &format!("view={view}&date=2026-10-19&week_start=0"),
        )
        .await;
        assert_eq!(response.status(), 200, "{view}");
        assert_eq!(response.headers()["content-type"], "application/pdf");
        let disposition = response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        let body = response.bytes().await.expect("body");
        assert!(body.starts_with(b"%PDF-"), "{view}");
    }
}

#[tokio::test]
async fn a_print_needs_a_known_view_a_date_and_a_session() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(
        print(&app, &alice, "view=decade&date=2026-10-19")
            .await
            .status(),
        400
    );
    assert_eq!(
        print(&app, &alice, "view=week&date=19/10/2026")
            .await
            .status(),
        422
    );
    assert_eq!(
        print(&app, &alice, "view=week&date=2026-10-19&week_start=7")
            .await
            .status(),
        422
    );
    assert_eq!(
        print(&app, "", "view=week&date=2026-10-19").await.status(),
        401
    );
}
