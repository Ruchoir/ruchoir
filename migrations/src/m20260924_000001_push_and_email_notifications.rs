//! Reach someone who has no Ruchoir tab open: Web Push subscriptions, the instance's VAPID keys,
//! and the bookkeeping of the email fallback.
//!
//! Until now a notification was written to the inbox and pushed over the real-time hub, which only
//! reaches a page that is open somewhere. Two channels are added (see ADR 0001):
//!
//! - **Web Push.** `push_subscriptions` holds one row per browser that asked for it. The instance
//!   signs its pushes with a VAPID key pair (RFC 8292) generated on first use and kept in
//!   `instance_settings`, the private half encrypted with the instance's secret key. An
//!   administrator can turn the whole channel off (`web_push_enabled`), because it is the one part
//!   of the product that talks to a service the instance does not choose.
//! - **Email fallback.** `notifications.email_handled_at` records that the fallback has decided
//!   about a row, whether it sent an email or not, so a notification is emailed at most once and
//!   the sweep only ever looks at undecided rows.
//!
//! Every notification that already exists is marked as handled: an inbox full of old unread
//! mentions must not turn into a flood of email the minute this is deployed.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "CREATE TABLE push_subscriptions ( \
                 id uuid PRIMARY KEY, \
                 user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
                 endpoint text NOT NULL UNIQUE, \
                 p256dh text NOT NULL, \
                 auth text NOT NULL, \
                 user_agent text, \
                 created_at timestamptz NOT NULL DEFAULT now(), \
                 last_success_at timestamptz, \
                 failures integer NOT NULL DEFAULT 0 \
             );",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);",
        )
        .await?;

        db.execute_unprepared("ALTER TABLE notifications ADD COLUMN email_handled_at timestamptz;")
            .await?;
        db.execute_unprepared(
            "UPDATE notifications SET email_handled_at = now() WHERE email_handled_at IS NULL;",
        )
        .await?;
        // The sweep reads undecided rows by age; everything it has decided about drops out of the
        // index, so it stays the size of the backlog rather than the size of the inbox.
        db.execute_unprepared(
            "CREATE INDEX idx_notifications_email_pending ON notifications (created_at) \
             WHERE email_handled_at IS NULL;",
        )
        .await?;

        db.execute_unprepared(
            "ALTER TABLE instance_settings \
                 ADD COLUMN web_push_enabled boolean NOT NULL DEFAULT true, \
                 ADD COLUMN vapid_public_key text, \
                 ADD COLUMN vapid_private_key bytea, \
                 ADD COLUMN vapid_private_nonce bytea;",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE instance_settings \
                 DROP COLUMN IF EXISTS web_push_enabled, \
                 DROP COLUMN IF EXISTS vapid_public_key, \
                 DROP COLUMN IF EXISTS vapid_private_key, \
                 DROP COLUMN IF EXISTS vapid_private_nonce;",
        )
        .await?;
        db.execute_unprepared("DROP INDEX IF EXISTS idx_notifications_email_pending;")
            .await?;
        db.execute_unprepared("ALTER TABLE notifications DROP COLUMN IF EXISTS email_handled_at;")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS push_subscriptions;")
            .await?;
        Ok(())
    }
}
