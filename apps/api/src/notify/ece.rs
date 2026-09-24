//! Message encryption for Web Push (RFC 8291, `aes128gcm` content coding from RFC 8188).
//!
//! Ruchoir's pushes say nothing: the service worker fetches what to draw from the API. They were
//! first sent with no body at all, which RFC 8030 allows and Chrome and Firefox accept, but Apple's
//! push service refuses (`400`). So each push now carries a body, and a body must be encrypted for
//! the subscription. What is encrypted is a fixed marker ([`WAKE`]), the same for every push: the
//! vendor still learns nothing beyond "something happened", which is what ADR 0001 promises.
//!
//! The derivation, for one message:
//!
//! 1. an ephemeral P-256 key pair for this message, and ECDH with the browser's `p256dh` key;
//! 2. HKDF with the browser's `auth` secret and both public keys into a 32-byte input key;
//! 3. HKDF with a random 16-byte salt into the content key (16 bytes) and the nonce (12 bytes);
//! 4. AES-128-GCM over the plaintext followed by the last-record delimiter `0x02`;
//! 5. the RFC 8188 header (salt, record size, the ephemeral public key) in front of it.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// What every push carries: a constant, so the ciphertext says nothing about any message.
pub const WAKE: &[u8] = b"ruchoir";

/// The record size announced in the header. Our one record is far smaller.
const RECORD_SIZE: u32 = 4096;

/// Decode base64url, with or without padding (browsers hand the keys over without it).
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for c in text.trim_end_matches('=').bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    Some(out)
}

fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(salt).expect("HMAC accepts any key length");
    mac.update(ikm);
    mac.finalize().into_bytes().into()
}

/// HKDF-Expand for outputs of at most one hash length, which is all this needs.
fn hkdf_expand(prk: &[u8; 32], info: &[u8], len: usize) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(prk).expect("HMAC accepts any key length");
    mac.update(info);
    mac.update(&[1]);
    mac.finalize().into_bytes()[..len].to_vec()
}

fn random<const N: usize>() -> Option<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes)
}

fn ephemeral_key() -> Option<SecretKey> {
    // As for the VAPID key: a random string is a valid scalar but for a vanishing fraction.
    for _ in 0..8 {
        if let Ok(key) = SecretKey::from_slice(&random::<32>()?) {
            return Some(key);
        }
    }
    None
}

/// Encrypt `plaintext` for a subscription whose keys are `p256dh` and `auth` (base64url), with the
/// given ephemeral key and salt. Split out so tests can fix both.
fn encrypt_with(
    plaintext: &[u8],
    p256dh: &str,
    auth: &str,
    ephemeral: &SecretKey,
    salt: [u8; 16],
) -> Option<Vec<u8>> {
    let ua_public_bytes = base64url_decode(p256dh)?;
    let auth_secret = base64url_decode(auth)?;
    if auth_secret.len() != 16 {
        return None;
    }
    let ua_public = PublicKey::from_sec1_bytes(&ua_public_bytes).ok()?;
    let as_public_point = ephemeral.public_key().to_sec1_point(false);
    let as_public = as_public_point.as_bytes();

    let shared = p256::ecdh::diffie_hellman(ephemeral.to_nonzero_scalar(), ua_public.as_affine());

    // Input key, bound to both parties.
    let prk_key = hkdf_extract(&auth_secret, shared.raw_secret_bytes());
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public.to_sec1_point(false).as_bytes());
    key_info.extend_from_slice(as_public);
    let ikm = hkdf_expand(&prk_key, &key_info, 32);

    // Content key and nonce, from the per-message salt.
    let prk = hkdf_extract(&salt, &ikm);
    let cek = hkdf_expand(&prk, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf_expand(&prk, b"Content-Encoding: nonce\0", 12);

    let mut record = plaintext.to_vec();
    record.push(0x02);
    let cipher = Aes128Gcm::new_from_slice(&cek).ok()?;
    let nonce = Nonce::try_from(nonce.as_slice()).ok()?;
    let sealed = cipher.encrypt(&nonce, record.as_slice()).ok()?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + sealed.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&sealed);
    Some(body)
}

/// Encrypt `plaintext` for one subscription, or `None` when its keys are unusable.
pub fn encrypt(plaintext: &[u8], p256dh: &str, auth: &str) -> Option<Vec<u8>> {
    encrypt_with(plaintext, p256dh, auth, &ephemeral_key()?, random::<16>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::vapid::base64url;

    /// The receiving side, as a browser runs it, to check the sender against.
    fn decrypt(body: &[u8], ua_secret: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        assert_eq!(
            u32::from_be_bytes(body[16..20].try_into().unwrap()),
            RECORD_SIZE
        );
        let id_len = body[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&body[21..21 + id_len]).unwrap();
        let sealed = &body[21 + id_len..];

        let shared =
            p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let prk_key = hkdf_extract(auth, shared.raw_secret_bytes());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua_secret.public_key().to_sec1_point(false).as_bytes());
        key_info.extend_from_slice(&body[21..21 + id_len]);
        let ikm = hkdf_expand(&prk_key, &key_info, 32);
        let prk = hkdf_extract(salt, &ikm);
        let cek = hkdf_expand(&prk, b"Content-Encoding: aes128gcm\0", 16);
        let nonce = hkdf_expand(&prk, b"Content-Encoding: nonce\0", 12);
        let cipher = Aes128Gcm::new_from_slice(&cek).unwrap();
        let mut plain = cipher
            .decrypt(&Nonce::try_from(nonce.as_slice()).unwrap(), sealed)
            .unwrap();
        assert_eq!(plain.pop(), Some(0x02), "last-record delimiter");
        plain
    }

    #[test]
    fn a_browser_can_read_what_is_sent() {
        let ua_secret = ephemeral_key().unwrap();
        let p256dh = base64url(ua_secret.public_key().to_sec1_point(false).as_bytes());
        let auth = [7u8; 16];
        let body = encrypt(WAKE, &p256dh, &base64url(&auth)).unwrap();
        assert_eq!(body[20], 65, "the key id is the uncompressed ephemeral key");
        assert_eq!(decrypt(&body, &ua_secret, &auth), WAKE);
    }

    #[test]
    fn every_message_uses_its_own_key_and_salt() {
        let ua_secret = ephemeral_key().unwrap();
        let p256dh = base64url(ua_secret.public_key().to_sec1_point(false).as_bytes());
        let auth = base64url(&[1u8; 16]);
        let first = encrypt(WAKE, &p256dh, &auth).unwrap();
        let second = encrypt(WAKE, &p256dh, &auth).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn unusable_keys_are_refused_rather_than_sent() {
        assert!(encrypt(WAKE, "not-a-point", &base64url(&[1u8; 16])).is_none());
        let ua_secret = ephemeral_key().unwrap();
        let p256dh = base64url(ua_secret.public_key().to_sec1_point(false).as_bytes());
        assert!(encrypt(WAKE, &p256dh, &base64url(&[1u8; 8])).is_none());
    }

    #[test]
    fn base64url_round_trips_with_or_without_padding() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", &[0xfb, 0xff, 0x00]] {
            let text = base64url(bytes);
            assert_eq!(base64url_decode(&text).unwrap(), bytes);
            assert_eq!(base64url_decode(&format!("{text}==")).unwrap(), bytes);
        }
        assert!(base64url_decode("a b").is_none());
    }
}
