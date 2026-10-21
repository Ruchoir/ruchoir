//! Checking that an address is a Ruchoir instance an app can sign in to.

use std::time::{Duration, Instant};

use axum::routing::get;
use axum::{Json, Router};
use ruchoir_desktop_core::instances::{check_instance, CheckError};
use serde_json::{json, Value};

async fn serve(answer: Option<Value>) -> String {
    let app = Router::new().route(
        "/api/v1/instance",
        get(move || {
            let answer = answer.clone();
            async move {
                match answer {
                    Some(body) => Json(body),
                    // An instance that takes the request and never answers.
                    None => {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        Json(json!({}))
                    }
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

const QUICK: Duration = Duration::from_millis(300);

#[tokio::test]
async fn an_instance_with_native_sessions_is_accepted() {
    let origin = serve(Some(
        json!({"native_sessions": true, "upload_max_bytes": 1}),
    ))
    .await;
    assert!(check_instance(&reqwest::Client::new(), &origin, QUICK)
        .await
        .is_ok());
}

#[tokio::test]
async fn an_older_instance_is_outdated() {
    let origin = serve(Some(json!({"upload_max_bytes": 1}))).await;
    let error = check_instance(&reqwest::Client::new(), &origin, QUICK)
        .await
        .unwrap_err();
    assert_eq!(error, CheckError::Outdated);
    let origin = serve(Some(json!({"native_sessions": false}))).await;
    let error = check_instance(&reqwest::Client::new(), &origin, QUICK)
        .await
        .unwrap_err();
    assert_eq!(error, CheckError::Outdated);
}

#[tokio::test]
async fn something_else_is_not_ruchoir() {
    let origin = serve(Some(json!({"hello": "world"}))).await;
    let error = check_instance(&reqwest::Client::new(), &origin, QUICK)
        .await
        .unwrap_err();
    assert_eq!(error, CheckError::NotRuchoir);
}

#[tokio::test]
async fn a_server_that_never_answers_gives_up_in_time() {
    let origin = serve(None).await;
    let started = Instant::now();
    let error = check_instance(&reqwest::Client::new(), &origin, QUICK)
        .await
        .unwrap_err();
    assert_eq!(error, CheckError::Unreachable);
    assert!(started.elapsed() < Duration::from_secs(2));
}
