//! Outgoing email over SMTP (verification and password-reset messages).
//!
//! When no SMTP relay is configured (`RUCHOIR_SMTP_HOST` unset), the mailer logs the message for
//! local development instead of sending it, so the flows are testable without a relay. That dev
//! fallback is the ONLY place a token-bearing link is logged, and only when SMTP is unconfigured;
//! production always sets SMTP_HOST and therefore sends.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;

/// Sends email, or logs it in local dev when no relay is configured.
#[derive(Clone)]
pub struct Mailer {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: String,
    /// Public base URL used to build links in email bodies.
    pub base_url: String,
}

impl Mailer {
    /// Build the mailer from configuration. Returns an error only on an invalid SMTP host.
    pub fn from_config(config: &Config) -> Result<Self, String> {
        let transport = match config.smtp_host.as_deref() {
            Some(host) if !host.is_empty() => {
                let mut builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
                    .map_err(|e| format!("invalid SMTP relay: {e}"))?
                    .port(config.smtp_port);
                if let (Some(user), Some(pass)) =
                    (config.smtp_username.clone(), config.smtp_password.clone())
                {
                    builder = builder.credentials(Credentials::new(user, pass));
                }
                Some(builder.build())
            }
            _ => None,
        };
        Ok(Self {
            transport,
            from: config.smtp_from.clone(),
            base_url: config.public_base_url.clone(),
        })
    }

    /// Whether this instance can actually deliver mail.
    ///
    /// [`Self::send`] answers `Ok` with no relay configured, because logging the message is the
    /// right behaviour for local development. Anything that *reports* a delivery to a person must
    /// ask this first: telling an administrator "the email is on its way" when it went to a log
    /// file is exactly the kind of lie the interface is being cleaned of.
    pub fn can_send(&self) -> bool {
        self.transport.is_some()
    }

    /// Send a plain-text email. In dev (no relay) the message is logged instead.
    pub async fn send(&self, to: &str, subject: &str, body: String) -> Result<(), String> {
        let Some(transport) = &self.transport else {
            tracing::info!(%to, %subject, "email not sent (no SMTP relay configured); body follows for dev:\n{body}");
            return Ok(());
        };
        let from: Mailbox = self
            .from
            .parse()
            .map_err(|e| format!("invalid From: {e}"))?;
        let to: Mailbox = to.parse().map_err(|e| format!("invalid To: {e}"))?;
        let email = Message::builder()
            .from(from)
            .to(to)
            .subject(subject)
            .body(body)
            .map_err(|e| format!("could not build email: {e}"))?;
        transport
            .send(email)
            .await
            .map_err(|e| format!("could not send email: {e}"))?;
        Ok(())
    }
}
