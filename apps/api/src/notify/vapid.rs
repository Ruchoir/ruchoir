//! The instance's VAPID identity (RFC 8292): the key pair a push service uses to recognise pushes
//! as coming from this server.
//!
//! A browser subscribes against a public key (`applicationServerKey`), and the push service then
//! accepts pushes for that subscription only when they carry a token signed with the matching private
//! key. The pair is therefore generated once per instance, on first use, and kept: replacing it
//! silently invalidates every subscription.
//!
//! The private half is a P-256 scalar, stored encrypted with the instance's secret key like the TOTP
//! secrets. If it can no longer be decrypted (the secret key was changed), a new pair is generated
//! and every subscription is dropped, since the push services would refuse them all anyway; each
//! browser subscribes again the next time the app is opened.

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;
use time::OffsetDateTime;

use crate::auth::crypto;
use crate::entities::{instance_settings, push_subscriptions};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// How long a signed token stays valid. RFC 8292 caps it at a day; Apple refuses more than an hour.
const TOKEN_TTL_SECS: i64 = 60 * 60;

/// The instance's key pair, ready to sign.
pub struct VapidKeys {
    signing: SigningKey,
    /// The public key as a browser expects it: uncompressed point, base64url without padding.
    pub public_key: String,
}

/// Base64url without padding (RFC 4648 section 5), the only encoding VAPID and JWT use.
///
/// Written out rather than pulled in: a crate for thirty lines of well-specified encoding is one
/// more dependency to vet for no gain.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = match chunk.len() {
            3 => u32::from(chunk[0]) << 16 | u32::from(chunk[1]) << 8 | u32::from(chunk[2]),
            2 => u32::from(chunk[0]) << 16 | u32::from(chunk[1]) << 8,
            _ => u32::from(chunk[0]) << 16,
        };
        let symbols = chunk.len() + 1;
        for i in 0..symbols {
            let index = (n >> (18 - 6 * i)) & 0x3f;
            out.push(char::from(ALPHABET[index as usize]));
        }
    }
    out
}

fn public_key_of(signing: &SigningKey) -> String {
    base64url(signing.verifying_key().to_sec1_point(false).as_bytes())
}

/// Draw a fresh private key from the operating system's CSPRNG.
fn generate() -> Result<SigningKey, ApiError> {
    // A random 32-byte string is a valid P-256 scalar unless it is zero or above the group order,
    // which happens with a probability around 2^-32: retrying is the standard answer.
    loop {
        let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| ApiError::Internal)?;
        if let Ok(key) = SigningKey::from_slice(bytes.as_ref()) {
            return Ok(key);
        }
    }
}

/// Read the instance's key pair, generating and storing it on first use.
pub async fn keys(state: &AppState) -> Result<VapidKeys, ApiError> {
    for _ in 0..2 {
        let settings = crate::admin::instance_settings(&state.db).await?;
        if let (Some(public_key), Some(ciphertext), Some(nonce)) = (
            settings.vapid_public_key.clone(),
            settings.vapid_private_key.as_deref(),
            settings.vapid_private_nonce.as_deref(),
        ) {
            let decrypted = crypto::decrypt(&state.secret_key, ciphertext, nonce)
                .ok()
                .and_then(|plain| SigningKey::from_slice(&plain).ok());
            if let Some(signing) = decrypted {
                return Ok(VapidKeys {
                    signing,
                    public_key,
                });
            }
            tracing::warn!(
                "the VAPID key can no longer be decrypted (was RUCHOIR_SECRET_ENCRYPTION_KEY \
                 changed?); generating a new pair and dropping every push subscription"
            );
            return replace(state).await;
        }

        // First use. Written only if nobody else wrote one in the meantime (two API processes
        // starting together), then read back, so every process ends up signing with the same key.
        let signing = generate()?;
        let (ciphertext, nonce) = crypto::encrypt(&state.secret_key, &signing.to_bytes())
            .map_err(|_| ApiError::Internal)?;
        instance_settings::Entity::update_many()
            .col_expr(
                instance_settings::Column::VapidPublicKey,
                Expr::value(public_key_of(&signing)),
            )
            .col_expr(
                instance_settings::Column::VapidPrivateKey,
                Expr::value(ciphertext),
            )
            .col_expr(
                instance_settings::Column::VapidPrivateNonce,
                Expr::value(nonce),
            )
            .filter(instance_settings::Column::VapidPrivateKey.is_null())
            .exec(&state.db)
            .await?;
        tracing::info!("generated the instance's VAPID key pair for Web Push");
    }
    Err(ApiError::Internal)
}

/// Replace an undecryptable key pair, dropping the subscriptions made against it.
async fn replace(state: &AppState) -> Result<VapidKeys, ApiError> {
    let signing = generate()?;
    let public_key = public_key_of(&signing);
    let (ciphertext, nonce) =
        crypto::encrypt(&state.secret_key, &signing.to_bytes()).map_err(|_| ApiError::Internal)?;
    instance_settings::Entity::update_many()
        .col_expr(
            instance_settings::Column::VapidPublicKey,
            Expr::value(public_key.clone()),
        )
        .col_expr(
            instance_settings::Column::VapidPrivateKey,
            Expr::value(ciphertext),
        )
        .col_expr(
            instance_settings::Column::VapidPrivateNonce,
            Expr::value(nonce),
        )
        .exec(&state.db)
        .await?;
    push_subscriptions::Entity::delete_many()
        .exec(&state.db)
        .await?;
    Ok(VapidKeys {
        signing,
        public_key,
    })
}

#[derive(Serialize)]
struct Claims<'a> {
    aud: &'a str,
    exp: i64,
    sub: &'a str,
}

impl VapidKeys {
    /// The `Authorization` header for one push: a JWT (ES256) naming the push service's origin,
    /// followed by the public key it must verify against.
    ///
    /// `audience` is the origin of the subscription's endpoint (`https://fcm.googleapis.com`), and
    /// `subject` how the push service can reach whoever runs this instance (a `mailto:` or an
    /// `https:` URL).
    pub fn authorization(&self, audience: &str, subject: &str, now: OffsetDateTime) -> String {
        let header = base64url(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::to_vec(&Claims {
            aud: audience,
            exp: now.unix_timestamp() + TOKEN_TTL_SECS,
            sub: subject,
        })
        .unwrap_or_default();
        let signing_input = format!("{header}.{}", base64url(&claims));
        let signature: Signature = self.signing.sign(signing_input.as_bytes());
        format!(
            "vapid t={signing_input}.{}, k={}",
            base64url(&signature.to_bytes()),
            self.public_key
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    #[test]
    fn base64url_matches_the_rfc_vectors() {
        // RFC 4648 section 10, minus the padding, in the URL-safe alphabet.
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn the_public_key_is_an_uncompressed_point() {
        let signing = generate().unwrap();
        // 65 bytes (0x04, x, y) encode to 87 characters without padding.
        let public = public_key_of(&signing);
        assert_eq!(public.len(), 87);
        assert!(public.starts_with('B'), "0x04 encodes as a leading B");
    }

    #[test]
    fn the_token_verifies_against_the_announced_key() {
        let signing = generate().unwrap();
        let keys = VapidKeys {
            public_key: public_key_of(&signing),
            signing,
        };
        let header = keys.authorization(
            "https://push.example",
            "mailto:admin@example.org",
            OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap(),
        );
        let token = header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split(", k=").next())
            .unwrap();
        let (signing_input, signature) = token.rsplit_once('.').unwrap();
        let signature_bytes = decode(signature);
        let signature = Signature::from_slice(&signature_bytes).unwrap();
        let verifying: &VerifyingKey = keys.signing.verifying_key();
        assert!(verifying
            .verify(signing_input.as_bytes(), &signature)
            .is_ok());

        let claims = decode(signing_input.split('.').nth(1).unwrap());
        let claims: serde_json::Value = serde_json::from_slice(&claims).unwrap();
        assert_eq!(claims["aud"], "https://push.example");
        assert_eq!(claims["sub"], "mailto:admin@example.org");
        assert_eq!(claims["exp"], 1_800_000_000 + TOKEN_TTL_SECS);
        assert!(header.ends_with(&format!("k={}", keys.public_key)));
    }

    /// Test-only decoder for the encoder above.
    fn decode(text: &str) -> Vec<u8> {
        const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = 0u32;
        let mut count = 0;
        let mut out = Vec::new();
        for c in text.chars() {
            bits = bits << 6 | ALPHABET.find(c).unwrap() as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
        out
    }
}
