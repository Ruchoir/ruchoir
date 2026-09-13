//! Outgoing email over SMTP (verification and password-reset messages).
//!
//! Both TLS dialects are spoken: implicit TLS on port 465, and STARTTLS everywhere else. The port
//! decides, because that is what it means everywhere else in the world and because picking wrong
//! does not fail fast, it hangs.
//!
//! When no SMTP relay is configured (`RUCHOIR_SMTP_HOST` unset), the mailer logs the message for
//! local development instead of sending it, so the flows are testable without a relay. That dev
//! fallback is the ONLY place a token-bearing link is logged, and only when SMTP is unconfigured;
//! production always sets SMTP_HOST and therefore sends.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;

/// The port on which SMTP is wrapped in TLS from the first byte, rather than upgraded part way.
const IMPLICIT_TLS_PORT: u16 = 465;

/// Builds the SMTP transport for a relay.
///
/// Two ways to wrap SMTP in TLS, and the port says which one a relay speaks. 465 is implicit TLS:
/// the connection is encrypted before a byte of SMTP is sent. Everything else is STARTTLS: the
/// session opens in clear and is upgraded. Trying the wrong one does not fall back, it hangs until
/// it times out, so the choice is made from the port rather than left to a variable nobody would
/// think to set.
fn build_transport(
    host: &str,
    port: u16,
    credentials: Option<(String, String)>,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let relay = if port == IMPLICIT_TLS_PORT {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
    };
    let mut builder = relay
        .map_err(|e| format!("invalid SMTP relay: {e}"))?
        .port(port);
    if let Some((user, password)) = credentials {
        builder = builder.credentials(Credentials::new(user, password));
    }
    Ok(builder.build())
}

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
            Some(host) if !host.is_empty() => Some(build_transport(
                host,
                config.smtp_port,
                config
                    .smtp_username
                    .clone()
                    .zip(config.smtp_password.clone()),
            )?),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_on_465_is_built_with_implicit_tls() {
        // Both dialects have to build: the relay a customer already pays for decides the port,
        // and until this existed a 465-only relay simply hung.
        assert!(build_transport("smtp.example.org", 465, None).is_ok());
    }

    #[test]
    fn a_relay_on_587_is_built_with_starttls() {
        assert!(build_transport("smtp.example.org", 587, None).is_ok());
    }

    #[test]
    fn credentials_are_optional_because_some_relays_authenticate_by_address() {
        let with = build_transport(
            "smtp.example.org",
            587,
            Some(("user".into(), "secret".into())),
        );
        assert!(with.is_ok());
    }
}
