//! Single-use MFA recovery codes.
//!
//! Codes are high-entropy strings shown to the user once. Only their HMAC-SHA-256 digest is stored,
//! so the database never holds a usable code. The HMAC key is derived from the data-encryption key
//! via a labelled HMAC (domain separation), so no separate secret needs configuring.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use super::error::AuthError;

type HmacSha256 = Hmac<Sha256>;

/// How many codes make up a set.
pub const CODE_COUNT: usize = 10;

// Unambiguous alphabet: no 0/O/1/l/i so hand-copied codes stay readable.
const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// Generate a fresh set of recovery codes (plaintext, to be shown once).
pub fn generate_codes() -> Result<Vec<String>, AuthError> {
    (0..CODE_COUNT).map(|_| generate_one()).collect()
}

/// HMAC-SHA-256 digest of a code, for storage and lookup. Constant in length and non-reversible.
///
/// The code is normalized first (see [`normalize`]), so a code typed back in capitals or with
/// stray spacing still matches the one that was issued.
pub fn hash_code(secret_key: &[u8; 32], code: &str) -> Vec<u8> {
    let subkey = derive_key(secret_key);
    let mut mac = HmacSha256::new_from_slice(&subkey).expect("HMAC accepts any key length");
    mac.update(normalize(code).as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Bring a code back to the form it was issued in: lower case, no surrounding or internal spaces.
///
/// Someone reading a code off paper types what they see, and what they see has no case (the
/// alphabet is lower case) and three groups that invite a space. Hyphens are kept, since they are
/// part of the issued string; everything else that differs is the reader's, not the code's.
fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Derive the recovery-code HMAC key from the data-encryption key with a fixed label.
fn derive_key(secret_key: &[u8; 32]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret_key).expect("HMAC accepts any key length");
    mac.update(b"ruchoir/recovery-code-v1");
    let out = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

/// One code: 15 characters from the unambiguous alphabet, in three groups of five (~74 bits).
fn generate_one() -> Result<String, AuthError> {
    let mut bytes = [0u8; 15];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::Internal)?;
    let chars: String = bytes
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect();
    Ok(format!(
        "{}-{}-{}",
        &chars[0..5],
        &chars[5..10],
        &chars[10..15]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_full_formatted_set() {
        let codes = generate_codes().unwrap();
        assert_eq!(codes.len(), CODE_COUNT);
        for code in &codes {
            assert_eq!(code.len(), 17); // 15 chars + two hyphens
            assert_eq!(code.matches('-').count(), 2);
        }
    }

    #[test]
    fn hashing_ignores_case_and_spacing() {
        let key = [3u8; 32];
        assert_eq!(
            hash_code(&key, "abc-def-ghi"),
            hash_code(&key, "  ABC-def- GHI ")
        );
        // Hyphens are part of the code, not decoration: dropping them is a different code.
        assert_ne!(hash_code(&key, "abc-def-ghi"), hash_code(&key, "abcdefghi"));
    }

    #[test]
    fn hashing_is_deterministic_and_key_separated() {
        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        assert_eq!(hash_code(&k1, "abc-def-ghi"), hash_code(&k1, "abc-def-ghi"));
        assert_ne!(hash_code(&k1, "abc-def-ghi"), hash_code(&k2, "abc-def-ghi"));
        assert_ne!(hash_code(&k1, "abc-def-ghi"), hash_code(&k1, "abc-def-ghj"));
    }
}
