//! Valkey (RESP) connectivity via fred.
//!
//! Backs opaque server sessions today and real-time pub-sub / presence in later lots. Dev speaks
//! plaintext RESP over the trusted Docker network; TLS would use fred's `enable-rustls-ring`
//! feature (ring, not AWS `aws-lc-rs`) when hardening later.

use fred::prelude::{Builder, ClientLike, Config as ValkeyConfig, Error, Pool};

use crate::config::Config;

/// Build and initialize the Valkey connection pool from configuration.
pub async fn connect(config: &Config) -> Result<Pool, Error> {
    connect_url(&config.valkey_url, config.valkey_pool_size).await
}

/// [`connect`], from the URL and the pool size alone.
pub async fn connect_url(url: &str, pool_size: usize) -> Result<Pool, Error> {
    let pool = builder(url)?.build_pool(pool_size)?;
    // Establish the connections up front so a misconfigured Valkey fails fast at startup.
    pool.init().await?;
    Ok(pool)
}

/// The builder every Valkey client of the API starts from: the command pool and the real-time
/// subscriber.
///
/// fred's defaults are no reconnection policy and no command timeout. With them, a Valkey that
/// restarts (an upgrade, a crash, a host reboot) closes every connection for good, and each command
/// afterwards waits forever: sessions, presence and the health probe all hang until the API itself
/// is restarted. So every client reconnects, retrying forever with a capped backoff, and no
/// command waits longer than a few seconds for an answer.
pub fn builder(url: &str) -> Result<Builder, Error> {
    let mut builder = Builder::from_config(ValkeyConfig::from_url(url)?);
    // 0 attempts means no limit: Valkey coming back an hour later is still picked up.
    builder.set_policy(fred::prelude::ReconnectPolicy::new_exponential(
        0, 100, 5_000, 2,
    ));
    builder.with_performance_config(|performance| {
        performance.default_command_timeout = std::time::Duration::from_secs(5);
    });
    builder.with_connection_config(|connection| {
        connection.connection_timeout = std::time::Duration::from_secs(5);
    });
    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fred::interfaces::ClientLike;
    use std::time::{Duration, Instant};

    #[test]
    fn every_client_reconnects_and_bounds_its_commands() {
        let builder = builder("redis://127.0.0.1:6379").expect("builder");
        let policy = builder.get_policy().expect("a reconnection policy");
        assert_eq!(policy.max_attempts(), 0, "retries forever");
        assert_eq!(
            builder.get_performance_config().default_command_timeout,
            Duration::from_secs(5)
        );
    }

    /// Needs a Valkey at `VALKEY_TEST_URL` (a throwaway one, as `CLAUDE.md` describes): it kills
    /// every other client's connection.
    #[tokio::test]
    async fn the_pool_answers_again_after_valkey_drops_its_connections() {
        let Ok(url) = std::env::var("VALKEY_TEST_URL") else {
            eprintln!("VALKEY_TEST_URL not set: skipping");
            return;
        };
        let pool = connect_url(&url, 2).await.expect("pool");
        let _: String = pool.ping(None).await.expect("first ping");

        // What a Valkey restart does to the API: every connection closed under it.
        let killer = fred::prelude::Builder::from_config(ValkeyConfig::from_url(&url).unwrap())
            .build()
            .expect("killer client");
        killer.init().await.expect("killer connects");
        let _: i64 = killer
            .custom(
                fred::cmd!("CLIENT"),
                vec!["KILL", "TYPE", "normal", "SKIPME", "yes"],
            )
            .await
            .expect("client kill");

        let started = Instant::now();
        loop {
            let ping =
                tokio::time::timeout(Duration::from_secs(6), pool.ping::<String>(None)).await;
            if matches!(ping, Ok(Ok(_))) {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "the pool never answered again after its connections were closed"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = killer.quit().await;
    }
}
