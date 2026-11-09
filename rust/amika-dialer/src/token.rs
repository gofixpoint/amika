//! Service tokens: how one Amika service proves to another that a request
//! is from it.
//!
//! A port of `verifyServiceToken` and the subject helpers in amika-mono's
//! `@amika/service-token`. The reverse proxy and the control plane mint the
//! tokens with that package, and the gateway checks them with it. The
//! dialer must accept exactly the tokens the gateway accepts, so this file
//! follows the TS code rule for rule. `tests/service_token_vectors.rs`
//! checks it against vectors that the TS code made.
//!
//! A token is `v1.<expiry ms>.<signature>`. The signature is an
//! HMAC-SHA256, unpadded base64url, over
//! `v1\n<subject UTF-8 byte count>\n<subject>\n<expiry>`, under a key that
//! is itself `HMAC-SHA256(secret, label)`.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const VERSION: &str = "v1";
/// 15 digits of Unix milliseconds reach the year 33658.
const MAX_EXPIRY_DIGITS: usize = 15;
/// An HMAC-SHA256 digest is 32 bytes: 43 base64url characters, unpadded.
const SIGNATURE_CHARS: usize = 43;

/// Why a token does not entitle its bearer to ask about a subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenFailure {
    Malformed,
    Invalid,
    Expired,
}

impl TokenFailure {
    /// The name the TS code uses for this failure.
    pub fn as_str(self) -> &'static str {
        match self {
            TokenFailure::Malformed => "malformed",
            TokenFailure::Invalid => "invalid",
            TokenFailure::Expired => "expired",
        }
    }
}

/// Checks `assertion` for `subject` under `label`. `now_ms` is Unix
/// milliseconds.
///
/// The checks run in the TS order: the envelope's shape, then the
/// signature, then the expiry. So a forged token and a stale one cost the
/// same work to tell apart. An empty secret grants nothing: Web Crypto
/// refuses a zero-length key, and this refuses every token under one.
pub fn verify(
    label: &str,
    secret: &str,
    subject: &str,
    assertion: &str,
    now_ms: u64,
) -> Result<(), TokenFailure> {
    let mut parts = assertion.split('.');
    let (Some(version), Some(expiry), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TokenFailure::Malformed);
    };
    if version != VERSION {
        return Err(TokenFailure::Malformed);
    }
    let expires_at = parse_expiry(expiry).ok_or(TokenFailure::Malformed)?;
    if signature.len() != SIGNATURE_CHARS
        || !signature
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(TokenFailure::Malformed);
    }
    if secret.is_empty() {
        return Err(TokenFailure::Invalid);
    }
    // One digest has four spellings in 43 characters. Only the canonical
    // one verifies, so one signature verifies one token string.
    let digest = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TokenFailure::Invalid)?;
    if URL_SAFE_NO_PAD.encode(&digest) != signature {
        return Err(TokenFailure::Invalid);
    }
    let mut mac = HmacSha256::new_from_slice(&derived_key(label, secret))
        .expect("HMAC takes a key of any length");
    mac.update(signed_text(subject, expires_at).as_bytes());
    mac.verify_slice(&digest)
        .map_err(|_| TokenFailure::Invalid)?;
    if expires_at <= now_ms {
        return Err(TokenFailure::Expired);
    }
    Ok(())
}

/// Mints a token, as `signServiceToken` does. The dialer only verifies;
/// tests use this to make requests.
pub fn sign(label: &str, secret: &str, subject: &str, expires_at: u64) -> String {
    let mut mac = HmacSha256::new_from_slice(&derived_key(label, secret))
        .expect("HMAC takes a key of any length");
    mac.update(signed_text(subject, expires_at).as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{VERSION}.{expires_at}.{signature}")
}

/// Several values as one subject, as `claimSubject` does. Each part
/// carries its length, so no list of parts spells another list.
///
/// The length is in UTF-16 code units, because the TS code uses
/// `string.length`.
pub fn claim_subject<S: AsRef<str>>(parts: &[S]) -> String {
    parts
        .iter()
        .map(|p| {
            let p = p.as_ref();
            format!("{}\n{p}", p.encode_utf16().count())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Digits only, no leading zero, at most 15 digits: one spelling for each
/// number.
fn parse_expiry(expiry: &str) -> Option<u64> {
    if expiry.is_empty()
        || expiry.len() > MAX_EXPIRY_DIGITS
        || !expiry.bytes().all(|b| b.is_ascii_digit())
        || (expiry.len() > 1 && expiry.starts_with('0'))
    {
        return None;
    }
    expiry.parse().ok()
}

/// The text the signature covers. The byte count is of UTF-8, because the
/// signature covers bytes.
fn signed_text(subject: &str, expires_at: u64) -> String {
    format!("{VERSION}\n{}\n{subject}\n{expires_at}", subject.len())
}

/// The key `label` derives from `secret`, so one secret serves several
/// purposes and a token for one never verifies as another.
fn derived_key(label: &str, secret: &str) -> Vec<u8> {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(label.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_tokens_verify_until_they_expire() {
        let token = sign("l", "s", "subj", 1_000);
        assert_eq!(verify("l", "s", "subj", &token, 999), Ok(()));
        assert_eq!(
            verify("l", "s", "subj", &token, 1_000),
            Err(TokenFailure::Expired)
        );
        assert_eq!(
            verify("l", "s", "subk", &token, 0),
            Err(TokenFailure::Invalid)
        );
        assert_eq!(
            verify("m", "s", "subj", &token, 0),
            Err(TokenFailure::Invalid)
        );
    }

    #[test]
    fn an_empty_secret_grants_nothing() {
        let token = sign("l", "", "subj", 1_000);
        assert_eq!(
            verify("l", "", "subj", &token, 0),
            Err(TokenFailure::Invalid)
        );
    }

    #[test]
    fn expiry_has_one_spelling() {
        assert_eq!(parse_expiry("0"), Some(0));
        assert_eq!(parse_expiry("01"), None);
        assert_eq!(parse_expiry("999999999999999"), Some(999_999_999_999_999));
        assert_eq!(parse_expiry("1000000000000000"), None);
        assert_eq!(parse_expiry("+1"), None);
        assert_eq!(parse_expiry(""), None);
    }
}
