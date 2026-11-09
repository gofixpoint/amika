//! The service-token port against vectors that amika-mono's
//! `@amika/service-token` made. `service-token-vectors.json` is a copy of
//! `js/service-token/src/test-vectors.json` there, where a test checks the
//! same vectors against the TS code. Change both or neither.

use amika_dialer::{forward, token};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    labels: Labels,
    proxy_forward_subjects: Vec<ProxySubject>,
    proxy_dialer_subjects: Vec<DialerSubject>,
    forward_subjects: Vec<ForwardSubject>,
    subjects: Vec<Subject>,
    tokens: Vec<Token>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Labels {
    proxy_to_gateway: String,
    control_plane_to_gateway: String,
    proxy_to_dialer: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    host_id: String,
    org_id: String,
    rig: String,
    service: String,
    authority: String,
}

#[derive(Deserialize)]
struct ProxySubject {
    claim: Claim,
    subject: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DialerClaim {
    host_id: String,
    org_id: String,
    rig: String,
    service: String,
    authority: String,
    endpoint_id: String,
    relay_url: Option<String>,
}

#[derive(Deserialize)]
struct DialerSubject {
    claim: DialerClaim,
    subject: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardSubject {
    host_id: String,
    org_id: String,
    subject: String,
}

#[derive(Deserialize)]
struct Subject {
    parts: Vec<String>,
    subject: String,
}

#[derive(Deserialize)]
struct Token {
    name: String,
    label: String,
    secret: String,
    subject: String,
    assertion: String,
    now: u64,
    expect: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("service-token-vectors.json")).unwrap()
}

#[test]
fn labels_match_the_hops() {
    let v = vectors();
    assert_eq!(v.labels.proxy_to_dialer, forward::DIALER_LABEL);
    assert_eq!(
        v.labels.proxy_to_gateway,
        "amika:reverse-proxy->gateway:forward-request:v2"
    );
    assert_eq!(
        v.labels.control_plane_to_gateway,
        "amika:control-plane->gateway:forward-request:v1"
    );
}

#[test]
fn subjects_match() {
    let v = vectors();
    assert!(!v.subjects.is_empty());
    for s in &v.subjects {
        assert_eq!(token::claim_subject(&s.parts), s.subject, "{:?}", s.parts);
    }
    for s in &v.proxy_forward_subjects {
        let c = &s.claim;
        let parts = [&c.host_id, &c.org_id, &c.rig, &c.service, &c.authority];
        assert_eq!(token::claim_subject(&parts), s.subject);
    }
    assert!(!v.proxy_dialer_subjects.is_empty());
    for s in &v.proxy_dialer_subjects {
        let c = &s.claim;
        let subject = forward::dialer_subject([
            &c.host_id,
            &c.org_id,
            &c.rig,
            &c.service,
            &c.authority,
            &c.endpoint_id,
            c.relay_url.as_deref().unwrap_or(""),
        ]);
        assert_eq!(subject, s.subject);
    }
    for s in &v.forward_subjects {
        assert_eq!(token::claim_subject(&[&s.host_id, &s.org_id]), s.subject);
    }
}

#[test]
fn every_token_verifies_as_the_ts_code_says() {
    let v = vectors();
    assert!(v.tokens.len() >= 30);
    for t in &v.tokens {
        let got = match token::verify(&t.label, &t.secret, &t.subject, &t.assertion, t.now) {
            Ok(()) => "ok",
            Err(f) => f.as_str(),
        };
        assert_eq!(got, t.expect, "vector {:?}", t.name);
    }
}

#[test]
fn tokens_minted_here_match_the_ts_tokens() {
    // A token is a pure function of its inputs, so minting the valid
    // vectors again must give the same strings.
    let v = vectors();
    for t in v.tokens.iter().filter(|t| t.expect == "ok") {
        let expiry: u64 = t.assertion.split('.').nth(1).unwrap().parse().unwrap();
        assert_eq!(
            token::sign(&t.label, &t.secret, &t.subject, expiry),
            t.assertion,
            "vector {:?}",
            t.name
        );
    }
}
