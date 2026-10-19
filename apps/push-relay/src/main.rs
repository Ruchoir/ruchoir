//! The push relay's process: reads its keys, serves `/health` and `/v1/send` (ADR 0006).
//!
//! Configuration, from the environment:
//!
//! - `RELAY_BIND`: where to listen (default `0.0.0.0:8080`; published on the loopback only, nginx in
//!   front adds TLS and the caller's address).
//! - `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`: the Apple team's push key. `APNS_TOPIC` defaults
//!   to the app's bundle id, `APNS_HOST` to production.
//! - `FCM_SERVICE_ACCOUNT_FILE`: the Firebase project's service account (JSON).
//!
//! A vendor whose key is missing is answered `503 not_configured`; the other keeps working.

use std::sync::Arc;

use ruchoir_push_relay::apns::{self, Apns};
use ruchoir_push_relay::fcm::Fcm;
use ruchoir_push_relay::{router, Pusher, Relay};

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn apns() -> Option<Arc<dyn Pusher>> {
    let file = env("APNS_KEY_FILE")?;
    let (Some(key_id), Some(team_id)) = (env("APNS_KEY_ID"), env("APNS_TEAM_ID")) else {
        tracing::warn!("APNS_KEY_FILE is set without APNS_KEY_ID and APNS_TEAM_ID: APNs off");
        return None;
    };
    let pem = match std::fs::read_to_string(&file) {
        Ok(pem) => pem,
        Err(e) => {
            tracing::warn!(%file, %e, "cannot read the APNs key: APNs off");
            return None;
        }
    };
    let topic = env("APNS_TOPIC").unwrap_or_else(|| "com.ruchoir.app".to_owned());
    let host = env("APNS_HOST").unwrap_or_else(|| apns::PRODUCTION_HOST.to_owned());
    match Apns::new(&pem, &key_id, &team_id, &topic, &host) {
        Ok(apns) => Some(Arc::new(apns)),
        Err(e) => {
            tracing::warn!(%e, "APNs off");
            None
        }
    }
}

fn fcm() -> Option<Arc<dyn Pusher>> {
    let file = env("FCM_SERVICE_ACCOUNT_FILE")?;
    let account = match std::fs::read_to_string(&file) {
        Ok(account) => account,
        Err(e) => {
            tracing::warn!(%file, %e, "cannot read the FCM service account: FCM off");
            return None;
        }
    };
    match Fcm::new(&account) {
        Ok(fcm) => Some(Arc::new(fcm)),
        Err(e) => {
            tracing::warn!(%e, "FCM off");
            None
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let relay = Arc::new(Relay::new(apns(), fcm()));
    tracing::info!(
        apns = relay.apns.is_some(),
        fcm = relay.fcm.is_some(),
        "push relay ready"
    );
    let bind = env("RELAY_BIND").unwrap_or_else(|| "0.0.0.0:8080".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("cannot listen on {bind}: {e}"));
    axum::serve(listener, router(relay))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
