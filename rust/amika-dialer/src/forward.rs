//! What the reverse proxy or the control plane sends the dialer, and
//! whether to believe it.
//!
//! A port of `readForwardRequest` in amika-mono's
//! `js/gateway-cloudflare/src/forward.ts`, and of the header rules in its
//! `request-headers.ts`. The dialer replaces the gateway for hosts on iroh,
//! so it accepts exactly the requests the gateway accepts:
//!
//! ```text
//! x-amika-host-id:      the host the proxy resolved
//! x-amika-org-id:       the organization the control plane named
//! x-amika-rig:          the rig, as the hostname named it
//! x-amika-service:      the service on it, likewise
//! x-amika-authority:    the address the caller asked the proxy for
//! x-amika-proxy-token:  a service token over all five
//! ```
//!
//! The control plane sends `x-amika-control-plane-token` in place of the
//! proxy's, with only the host and the organization. Exactly one assertion
//! must be present. Each is also read under its earlier name, but not under
//! both names at once.
//!
//! The dialer also reads two headers that the gateway does not need:
//! `x-amika-endpoint-id`, the host's iroh endpoint id, and
//! `x-amika-relay-url`, its home relay. The assertion does not cover them:
//! the contract keeps the gateway's signed headers unchanged. They are read
//! only after the assertion verifies.
//!
//! Header values are read as the Fetch `Headers` object reads them: a
//! repeated header is one value joined with `", "`, and each byte is one
//! character (a `ByteString`). So a value checks and signs here exactly as
//! it does in the gateway.

use std::str::FromStr;

use http::{HeaderMap, HeaderName, HeaderValue, Method, request::Parts};
use iroh::{EndpointId, RelayUrl};

use crate::token;

pub const HOST_ID_HEADER: &str = "x-amika-host-id";
pub const ORG_ID_HEADER: &str = "x-amika-org-id";
pub const RIG_HEADER: &str = "x-amika-rig";
pub const SERVICE_HEADER: &str = "x-amika-service";
pub const AUTHORITY_HEADER: &str = "x-amika-authority";
pub const PROXY_ASSERTION_HEADER: &str = "x-amika-proxy-token";
pub const LEGACY_PROXY_ASSERTION_HEADER: &str = "x-amika-proxy-assertion";
pub const CONTROL_PLANE_ASSERTION_HEADER: &str = "x-amika-control-plane-token";
pub const LEGACY_CONTROL_PLANE_ASSERTION_HEADER: &str = "x-amika-control-plane-assertion";
pub const ENDPOINT_ID_HEADER: &str = "x-amika-endpoint-id";
pub const RELAY_URL_HEADER: &str = "x-amika-relay-url";

/// Every name an assertion arrives under.
pub const ASSERTION_HEADERS: [&str; 4] = [
    PROXY_ASSERTION_HEADER,
    LEGACY_PROXY_ASSERTION_HEADER,
    CONTROL_PLANE_ASSERTION_HEADER,
    LEGACY_CONTROL_PLANE_ASSERTION_HEADER,
];

/// `PROXY_TO_GATEWAY.label` in `@amika/service-token/hops`.
pub const PROXY_LABEL: &str = "amika:reverse-proxy->gateway:forward-request:v2";
/// `CONTROL_PLANE_TO_GATEWAY.label` in `@amika/service-token/hops`.
pub const CONTROL_PLANE_LABEL: &str = "amika:control-plane->gateway:forward-request:v1";

/// Who may ask the dialer to reach a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Proxy,
    ControlPlane,
}

/// The secrets that verify who is forwarding.
#[derive(Debug, Clone)]
pub struct Secrets {
    /// Verifies the proxy's assertions.
    pub proxy: String,
    /// Verifies the control plane's. `None` refuses every such request.
    pub control_plane: Option<String>,
}

/// A forwarding instruction the dialer has checked.
///
/// `Parsed` because it is stronger than what arrived: the host id and the
/// organization are the pair the caller signed, the target is origin-form,
/// and the headers carry nothing from Amika's own namespace except the
/// rig and the service the proxy signed.
#[derive(Debug, Clone)]
pub struct ForwardRequestParsed {
    pub caller: Caller,
    pub host_id: String,
    pub org_id: String,
    /// Presented to the host as `Host`.
    pub authority: String,
    pub method: Method,
    /// Path and query. Origin-form.
    pub target: String,
    /// A WebSocket upgrade.
    pub upgrade: bool,
    /// What the host receives, `Host` included.
    pub headers: HeaderMap,
    /// The host's iroh endpoint.
    pub endpoint_id: EndpointId,
    /// The host's home relay, when the caller named one.
    pub relay_url: Option<RelayUrl>,
}

/// Why the dialer will not forward a request. The reason goes to the log,
/// never to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub reason: String,
}

fn refuse<T>(status: u16, reason: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        status,
        reason: reason.into(),
    })
}

/// Reads a forwarding instruction out of a request head, or says why there
/// is none.
///
/// The structural checks come first, because the signature covers values
/// that must each be one unambiguous string. The signature comes next, so
/// a caller that cannot prove who it is learns nothing about its request.
pub fn read_forward_request(
    parts: &Parts,
    secrets: &Secrets,
    now_ms: u64,
) -> Result<ForwardRequestParsed, Refusal> {
    let headers = &parts.headers;
    let (Some(host_id), Some(org_id)) = (
        single(get(headers, HOST_ID_HEADER)),
        single(get(headers, ORG_ID_HEADER)),
    ) else {
        return refuse(
            400,
            format!("{HOST_ID_HEADER} and {ORG_ID_HEADER} are both required"),
        );
    };
    if !is_id(&host_id) || !is_id(&org_id) {
        return refuse(400, "host or org id is malformed");
    }

    let proxy_assertion = either_name(
        headers,
        PROXY_ASSERTION_HEADER,
        LEGACY_PROXY_ASSERTION_HEADER,
    )?;
    let control_plane_assertion = either_name(
        headers,
        CONTROL_PLANE_ASSERTION_HEADER,
        LEGACY_CONTROL_PLANE_ASSERTION_HEADER,
    )?;
    let claim = match (proxy_assertion, control_plane_assertion) {
        (Some(_), Some(_)) => return refuse(400, "two assertions"),
        (Some(assertion), None) => proxy_claim(headers, &host_id, &org_id, assertion, secrets)?,
        (None, Some(assertion)) => {
            control_plane_claim(parts, &host_id, &org_id, assertion, secrets)
        }
        (None, None) => return refuse(401, format!("{PROXY_ASSERTION_HEADER} is absent")),
    };
    let Some(secret) = claim.secret else {
        return refuse(401, "control-plane forwarding is not configured");
    };
    if let Err(failure) = token::verify(
        claim.label,
        secret,
        &claim.subject,
        &claim.assertion,
        now_ms,
    ) {
        // One status for all three failures. Which it was goes to the log.
        return refuse(401, format!("assertion {}", failure.as_str()));
    }

    let authority = match claim.authority {
        Some(a) if is_authority(&a) => a,
        _ => return refuse(400, "Host is absent or malformed"),
    };
    let target = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    if !is_origin_form(&target) {
        return refuse(400, "request target is not a path");
    }
    let (endpoint_id, relay_url) = read_endpoint(headers)?;

    let upgrade = get(headers, "upgrade")
        .map(|v| trim_js(&v).eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    let headers = host_headers(headers, &authority, claim.rig_service.as_ref(), upgrade)?;
    Ok(ForwardRequestParsed {
        caller: claim.caller,
        host_id,
        org_id,
        authority,
        method: parts.method.clone(),
        target,
        upgrade,
        headers,
        endpoint_id,
        relay_url,
    })
}

/// Whether a request carries any assertion. The health path answers only
/// a request that carries none.
pub fn has_assertion(headers: &HeaderMap) -> bool {
    ASSERTION_HEADERS.iter().any(|n| headers.contains_key(*n))
}

struct Claim<'a> {
    caller: Caller,
    assertion: String,
    label: &'static str,
    secret: Option<&'a str>,
    subject: String,
    authority: Option<String>,
    rig_service: Option<(String, String)>,
}

/// What the proxy claims. The rig, the service and the authority are
/// required: a proxy that sent none would have the host serve its own API
/// to a browser.
fn proxy_claim<'a>(
    headers: &HeaderMap,
    host_id: &str,
    org_id: &str,
    assertion: String,
    secrets: &'a Secrets,
) -> Result<Claim<'a>, Refusal> {
    let (Some(rig), Some(service), Some(authority)) = (
        single(get(headers, RIG_HEADER)),
        single(get(headers, SERVICE_HEADER)),
        single(get(headers, AUTHORITY_HEADER)),
    ) else {
        return refuse(
            400,
            format!("{RIG_HEADER}, {SERVICE_HEADER} and {AUTHORITY_HEADER} are all required"),
        );
    };
    if !is_name(&rig) || !is_name(&service) {
        return refuse(400, "rig or service is not a name");
    }
    Ok(Claim {
        caller: Caller::Proxy,
        assertion,
        label: PROXY_LABEL,
        secret: Some(&secrets.proxy),
        subject: token::claim_subject(&[host_id, org_id, &rig, &service, &authority]),
        authority: Some(authority),
        rig_service: Some((rig, service)),
    })
}

/// What the control plane claims: a host and an organization, and no rig.
/// The authority is the address the request was sent to, which the host's
/// API does not route by.
fn control_plane_claim<'a>(
    parts: &Parts,
    host_id: &str,
    org_id: &str,
    assertion: String,
    secrets: &'a Secrets,
) -> Claim<'a> {
    let authority = single(get(&parts.headers, "host"))
        .or_else(|| parts.uri.authority().map(|a| a.as_str().to_string()));
    Claim {
        caller: Caller::ControlPlane,
        assertion,
        label: CONTROL_PLANE_LABEL,
        secret: secrets.control_plane.as_deref(),
        subject: token::claim_subject(&[host_id, org_id]),
        authority,
        rig_service: None,
    }
}

/// The host's endpoint id and home relay. The id is required: without it
/// there is nothing to dial.
fn read_endpoint(headers: &HeaderMap) -> Result<(EndpointId, Option<RelayUrl>), Refusal> {
    let Some(raw) = single(get(headers, ENDPOINT_ID_HEADER)) else {
        return refuse(400, format!("{ENDPOINT_ID_HEADER} is required"));
    };
    if raw.len() != 64 || !raw.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return refuse(400, "endpoint id is not 64 lowercase hex digits");
    }
    let Ok(endpoint_id) = EndpointId::from_str(&raw) else {
        return refuse(400, "endpoint id is not a public key");
    };
    let relay_url = match single(get(headers, RELAY_URL_HEADER)) {
        None => None,
        Some(raw) => match RelayUrl::from_str(&raw) {
            Ok(url) if matches!(url.scheme(), "http" | "https") => Some(url),
            _ => return refuse(400, "relay url is malformed"),
        },
    };
    Ok((endpoint_id, relay_url))
}

/// The value under `name` or under `legacy`. A request that sends both is
/// refused: the two values could differ, and the dialer must not choose.
fn either_name(headers: &HeaderMap, name: &str, legacy: &str) -> Result<Option<String>, Refusal> {
    match (single(get(headers, name)), single(get(headers, legacy))) {
        (Some(_), Some(_)) => refuse(400, "an assertion under both its names"),
        (current, earlier) => Ok(current.or(earlier)),
    }
}

/// A header as `Headers.get` reads it: every value joined with `", "`,
/// one character per byte.
fn get(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| b as char).collect())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// A header's value, trimmed, or `None` when absent or blank.
fn single(value: Option<String>) -> Option<String> {
    let trimmed = trim_js(value.as_deref()?);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// What JS `String.prototype.trim` removes, over the characters a header
/// can hold (U+0000 to U+00FF).
fn is_js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}')
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// A host or organization id: no comma and no space (`/^[^,\s]{1,256}$/`).
/// A repeated header reads as one value joined with `", "`, so this also
/// refuses a repeated header.
fn is_id(s: &str) -> bool {
    let n = s.chars().count();
    (1..=256).contains(&n) && !s.chars().any(|c| c == ',' || is_js_space(c))
}

/// A rig or a service name: one DNS label (`/^[A-Za-z0-9-]{1,63}$/`).
fn is_name(s: &str) -> bool {
    (1..=63).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An authority with no userinfo, no path and no splice in it
/// (`/^[A-Za-z0-9._-]+(:[0-9]+)?$/`).
fn is_authority(s: &str) -> bool {
    let host_ok = |h: &str| {
        !h.is_empty()
            && h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    match s.split_once(':') {
        None => host_ok(s),
        Some((host, port)) => {
            host_ok(host) && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

/// One leading slash, and nothing behind it that reads as the start of an
/// authority. A target with an authority overrides the `Host` the host is
/// told.
fn is_origin_form(target: &str) -> bool {
    let b = target.as_bytes();
    b.first() == Some(&b'/') && !matches!(b.get(1), Some(b'/') | Some(b'\\'))
}

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Namespaces only an intermediary writes, dropped whole. A namespace
/// matches its own bare name as well.
const INTERMEDIARY_NAMESPACES: [&str; 3] = ["x-forwarded", "cf", "x-amika"];

/// The same statements under names no namespace covers.
const CLIENT_SPOOFABLE: [&str; 10] = [
    "forwarded",
    "forwarded-for",
    "x-real-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "true-client-ip",
    "fastly-client-ip",
    "fly-client-ip",
    "x-vercel-forwarded-for",
    "x-original-forwarded-for",
];

/// Names a `Connection` header may not nominate.
const NEVER_NOMINATED: [&str; 3] = ["content-length", "transfer-encoding", "host"];

/// The headers the host receives.
///
/// The gateway's rules: the caller's headers, with hop-by-hop headers, the
/// headers that a `Connection` header names, client-spoofable headers and
/// the `x-forwarded`, `cf` and `x-amika` namespaces removed. Then `Host`,
/// and the rig and the service the proxy signed, written after the removal
/// so a host that reads them reads what the dialer wrote.
///
/// One difference, on an upgrade. The gateway ends the caller's WebSocket
/// and opens its own to the host, so it drops the caller's
/// `Sec-WebSocket-Key` and extension offer. The dialer passes the
/// handshake's bytes through to the host, so it keeps them, and writes
/// `Connection: upgrade` and `Upgrade: websocket` for its own hop.
fn host_headers(
    incoming: &HeaderMap,
    authority: &str,
    rig_service: Option<&(String, String)>,
    upgrade: bool,
) -> Result<HeaderMap, Refusal> {
    let nominated = nominated(incoming);
    let mut out = HeaderMap::new();
    for (name, value) in incoming {
        let lowered = name.as_str();
        let dropped = HOP_BY_HOP.contains(&lowered)
            || CLIENT_SPOOFABLE.contains(&lowered)
            || lowered == "host"
            || lowered == "set-cookie"
            || (upgrade && lowered == "content-length")
            || nominated.iter().any(|n| n == lowered)
            || in_intermediary_namespace(lowered);
        if !dropped {
            out.append(name.clone(), value.clone());
        }
    }
    let value = |v: &str| {
        HeaderValue::from_str(v).or_else(|_| refuse(400, "a signed value is not a header value"))
    };
    out.insert(http::header::HOST, value(authority)?);
    if let Some((rig, service)) = rig_service {
        out.insert(HeaderName::from_static(RIG_HEADER), value(rig)?);
        out.insert(HeaderName::from_static(SERVICE_HEADER), value(service)?);
    }
    if upgrade {
        out.insert(
            http::header::CONNECTION,
            HeaderValue::from_static("upgrade"),
        );
        out.insert(http::header::UPGRADE, HeaderValue::from_static("websocket"));
    }
    Ok(out)
}

/// A host's response headers as the caller should see them: hop-by-hop
/// headers and the headers its `Connection` header names are removed. On a
/// `101`, `Connection` and `Upgrade` stay, because they describe the hop
/// the response switches.
pub fn relayable_response_headers(incoming: &HeaderMap, switching: bool) -> HeaderMap {
    let nominated = nominated(incoming);
    let mut out = HeaderMap::new();
    for (name, value) in incoming {
        let lowered = name.as_str();
        let keep_for_switch = switching && matches!(lowered, "connection" | "upgrade");
        if !keep_for_switch
            && (HOP_BY_HOP.contains(&lowered) || nominated.iter().any(|n| n == lowered))
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// The names a `Connection` header lists, except the ones RFC 9110 forbids
/// it to list.
fn nominated(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(http::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty() && !NEVER_NOMINATED.contains(&n.as_str()))
        .collect()
}

fn in_intermediary_namespace(lowered: &str) -> bool {
    INTERMEDIARY_NAMESPACES.iter().any(|space| {
        lowered == *space
            || lowered
                .strip_prefix(space)
                .is_some_and(|rest| rest.starts_with('-'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_794_200_000_000;
    const ENDPOINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn secrets() -> Secrets {
        Secrets {
            proxy: "proxy-secret".into(),
            control_plane: Some("cp-secret".into()),
        }
    }

    fn endpoint() -> String {
        // A valid Ed25519 point: the public key of a fixed secret.
        iroh::SecretKey::from_bytes(&[7u8; 32]).public().to_string()
    }

    fn proxy_request(extra: &[(&str, &str)]) -> http::request::Builder {
        let subject = token::claim_subject(&[
            "h1",
            "o1",
            "my-rig",
            "web",
            "web--my-rig.r.acme.o.amika.run",
        ]);
        let assertion = token::sign(PROXY_LABEL, "proxy-secret", &subject, NOW + 10_000);
        let mut b = http::Request::builder()
            .method("GET")
            .uri("/index.html?q=1")
            .header("host", "dialer.example")
            .header(HOST_ID_HEADER, "h1")
            .header(ORG_ID_HEADER, "o1")
            .header(RIG_HEADER, "my-rig")
            .header(SERVICE_HEADER, "web")
            .header(AUTHORITY_HEADER, "web--my-rig.r.acme.o.amika.run")
            .header(PROXY_ASSERTION_HEADER, assertion)
            .header(ENDPOINT_ID_HEADER, endpoint());
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        b
    }

    fn read(b: http::request::Builder) -> Result<ForwardRequestParsed, Refusal> {
        let (parts, ()) = b.body(()).unwrap().into_parts();
        read_forward_request(&parts, &secrets(), NOW)
    }

    #[test]
    fn a_signed_proxy_request_reads_with_host_headers() {
        let r = read(proxy_request(&[
            ("x-amika-relay-url", "https://relay.example/"),
            ("cookie", "a=b"),
            ("x-forwarded-for", "1.2.3.4"),
            ("cf-connecting-ip", "1.2.3.4"),
            ("x-amika-extra", "nope"),
            ("connection", "keep-alive, x-drop-me"),
            ("x-drop-me", "1"),
            ("fly-client-ip", "1.2.3.4"),
        ]))
        .unwrap();
        assert_eq!(r.caller, Caller::Proxy);
        assert_eq!(r.target, "/index.html?q=1");
        assert_eq!(r.authority, "web--my-rig.r.acme.o.amika.run");
        assert_eq!(r.endpoint_id.to_string(), endpoint());
        assert_eq!(r.relay_url.unwrap().to_string(), "https://relay.example/");
        let names: Vec<&str> = r.headers.keys().map(|k| k.as_str()).collect();
        assert!(names.contains(&"cookie"));
        for gone in [
            "x-forwarded-for",
            "cf-connecting-ip",
            "x-amika-extra",
            "x-amika-proxy-token",
            "x-amika-endpoint-id",
            "x-amika-host-id",
            "connection",
            "x-drop-me",
            "fly-client-ip",
        ] {
            assert!(!names.contains(&gone), "{gone} was forwarded");
        }
        assert_eq!(r.headers["host"], "web--my-rig.r.acme.o.amika.run");
        assert_eq!(r.headers[RIG_HEADER], "my-rig");
        assert_eq!(r.headers[SERVICE_HEADER], "web");
    }

    #[test]
    fn an_upgrade_keeps_the_handshake() {
        let r = read(proxy_request(&[
            ("upgrade", "WebSocket"),
            ("connection", "Upgrade"),
            ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("sec-websocket-version", "13"),
            ("content-length", "0"),
        ]))
        .unwrap();
        assert!(r.upgrade);
        assert_eq!(r.headers["upgrade"], "websocket");
        assert_eq!(r.headers["connection"], "upgrade");
        assert_eq!(r.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
        assert!(!r.headers.contains_key("content-length"));
    }

    #[test]
    fn refusals_have_the_gateway_statuses() {
        let status = |b| read(b).unwrap_err().status;
        // No assertion.
        let mut b = http::Request::builder()
            .uri("/")
            .header(HOST_ID_HEADER, "h1")
            .header(ORG_ID_HEADER, "o1");
        assert_eq!(status(b), 401);
        // No host id.
        b = http::Request::builder()
            .uri("/")
            .header(ORG_ID_HEADER, "o1");
        assert_eq!(status(b), 400);
        // A repeated host id reads as "h1, h2" and is refused.
        assert_eq!(status(proxy_request(&[(HOST_ID_HEADER, "h2")])), 400);
        // Both names of the assertion.
        assert_eq!(
            status(proxy_request(&[(LEGACY_PROXY_ASSERTION_HEADER, "v1.1.x")])),
            400
        );
        // Two assertions.
        assert_eq!(
            status(proxy_request(&[(CONTROL_PLANE_ASSERTION_HEADER, "v1.1.x")])),
            400
        );
        // A rig that is not a name.
        let mut b = proxy_request(&[]);
        b.headers_mut()
            .unwrap()
            .insert(RIG_HEADER, "a.b".parse().unwrap());
        assert_eq!(status(b), 400);
        // A changed authority breaks the signature.
        let mut b = proxy_request(&[]);
        b.headers_mut()
            .unwrap()
            .insert(AUTHORITY_HEADER, "evil.example".parse().unwrap());
        assert_eq!(status(b), 401);
        // A target that reads as an authority.
        let b = proxy_request(&[]).uri("//evil.example/x");
        assert_eq!(status(b), 400);
        // No endpoint id, or a bad one, after the assertion verifies.
        let mut b = proxy_request(&[]);
        b.headers_mut().unwrap().remove(ENDPOINT_ID_HEADER);
        assert_eq!(status(b), 400);
        let mut b = proxy_request(&[]);
        b.headers_mut()
            .unwrap()
            .insert(ENDPOINT_ID_HEADER, ENDPOINT.to_uppercase().parse().unwrap());
        assert_eq!(status(b), 400);
        assert_eq!(
            status(proxy_request(&[(RELAY_URL_HEADER, "ftp://relay.example")])),
            400
        );
    }

    #[test]
    fn an_expired_or_forged_assertion_is_401() {
        let (parts, ()) = proxy_request(&[]).body(()).unwrap().into_parts();
        let late = read_forward_request(&parts, &secrets(), NOW + 10_000).unwrap_err();
        assert_eq!(late.status, 401);
        assert_eq!(late.reason, "assertion expired");
        let other = Secrets {
            proxy: "other".into(),
            control_plane: None,
        };
        let forged = read_forward_request(&parts, &other, NOW).unwrap_err();
        assert_eq!(forged.reason, "assertion invalid");
    }

    #[test]
    fn the_control_plane_reaches_the_host_api_without_a_rig() {
        let subject = token::claim_subject(&["h1", "o1"]);
        let assertion = token::sign(CONTROL_PLANE_LABEL, "cp-secret", &subject, NOW + 10_000);
        let b = http::Request::builder()
            .method("POST")
            .uri("/v0beta1/rigs")
            .header("host", "dialer.example")
            .header(HOST_ID_HEADER, "h1")
            .header(ORG_ID_HEADER, "o1")
            .header(CONTROL_PLANE_ASSERTION_HEADER, assertion.clone())
            .header(ENDPOINT_ID_HEADER, endpoint());
        let r = read(b).unwrap();
        assert_eq!(r.caller, Caller::ControlPlane);
        assert_eq!(r.authority, "dialer.example");
        assert!(!r.headers.contains_key(RIG_HEADER));

        let b = http::Request::builder()
            .uri("/")
            .header("host", "dialer.example")
            .header(HOST_ID_HEADER, "h1")
            .header(ORG_ID_HEADER, "o1")
            .header(CONTROL_PLANE_ASSERTION_HEADER, assertion)
            .header(ENDPOINT_ID_HEADER, endpoint());
        let (parts, ()) = b.body(()).unwrap().into_parts();
        let off = Secrets {
            proxy: "proxy-secret".into(),
            control_plane: None,
        };
        let r = read_forward_request(&parts, &off, NOW).unwrap_err();
        assert_eq!(r.reason, "control-plane forwarding is not configured");
    }

    #[test]
    fn shape_rules_match_the_gateway_patterns() {
        assert!(is_id("host_01"));
        assert!(!is_id("a,b"));
        assert!(!is_id("a b"));
        assert!(!is_id("a\u{a0}b"));
        assert!(!is_id(&"x".repeat(257)));
        assert!(is_authority("a.b-c_d:8080"));
        assert!(!is_authority("a@b"));
        assert!(!is_authority("a:"));
        assert!(!is_authority("a:1:2"));
        assert!(is_origin_form("/x"));
        assert!(!is_origin_form("/\\x"));
        assert!(!is_origin_form("x"));
        assert!(in_intermediary_namespace("cf"));
        assert!(in_intermediary_namespace("cf-ray"));
        assert!(!in_intermediary_namespace("cfx"));
    }

    #[test]
    fn response_headers_drop_hop_by_hop_except_on_a_switch() {
        let mut h = HeaderMap::new();
        h.insert("connection", "upgrade, x-private".parse().unwrap());
        h.insert("upgrade", "websocket".parse().unwrap());
        h.insert("x-private", "1".parse().unwrap());
        h.insert("transfer-encoding", "chunked".parse().unwrap());
        h.append("set-cookie", "a=1".parse().unwrap());
        h.append("set-cookie", "b=2".parse().unwrap());
        let plain = relayable_response_headers(&h, false);
        assert!(!plain.contains_key("connection"));
        assert!(!plain.contains_key("x-private"));
        assert!(!plain.contains_key("transfer-encoding"));
        assert_eq!(plain.get_all("set-cookie").iter().count(), 2);
        let switched = relayable_response_headers(&h, true);
        assert!(switched.contains_key("connection"));
        assert!(switched.contains_key("upgrade"));
    }
}
