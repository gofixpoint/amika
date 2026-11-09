//! The local protocol between `connect` and the agent, on the agent's Unix
//! socket.
//!
//! Each message is one frame (see [`crate::frame`]) whose body is
//! `key value` lines. Unknown keys are ignored, so a later version can add
//! optional fields.
//!
//! 1. The client sends a hello: its protocol range, its build, and (for a
//!    `connect` client) the agent config it needs.
//! 2. The agent answers with a hello: its build, pid, endpoint id, open
//!    stream count, and an action from [`decide`].
//! 3. After `action use`, the client sends one request: `op connect` (a
//!    host and a target) or `op stop`.
//! 4. The agent answers `ok` or `error <detail>`. After `ok` to a connect,
//!    the socket carries raw bytes both ways.
//!
//! Both hellos keep this shape in every version: they are how two versions
//! find out that they differ. Key material never crosses the socket.

use std::net::SocketAddr;

use anyhow::{Context, Result, anyhow, bail};
use iroh::{EndpointId, RelayUrl};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{connect::HostAddrArgs, frame, header::Target};

/// The oldest local protocol version this build speaks.
pub const PROTO_MIN: u32 = 1;
/// The newest local protocol version this build speaks.
pub const PROTO_MAX: u32 = 1;

/// Test-only: replaces both ends of this process's protocol range, so a
/// test can act as an incompatible build.
const TEST_PROTO_ENV: &str = "TEST_AMIKA_NET_AGENT_PROTO";
/// Test-only: replaces this process's build string, so a test can act as an
/// upgraded binary.
const TEST_BUILD_ENV: &str = "TEST_AMIKA_NET_BUILD";

/// The largest local frame either side accepts.
const MAX_FRAME: usize = 8 * 1024;

/// This process's protocol range.
pub fn proto_range() -> (u32, u32) {
    match std::env::var(TEST_PROTO_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
    {
        Some(v) => (v, v),
        None => (PROTO_MIN, PROTO_MAX),
    }
}

/// This process's build string: the crate version.
pub fn build() -> String {
    std::env::var(TEST_BUILD_ENV).unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

/// The client's hello.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientHello {
    pub proto_min: u32,
    pub proto_max: u32,
    pub build: String,
    /// The agent config a `connect` client needs: the key file and endpoint
    /// options. `None` for a control client (`agent status`, `agent stop`).
    pub config: Option<String>,
}

impl ClientHello {
    /// A hello for this process.
    pub fn this_process(config: Option<String>) -> Self {
        let (proto_min, proto_max) = proto_range();
        Self {
            proto_min,
            proto_max,
            build: build(),
            config,
        }
    }
}

/// What the agent tells a client to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Send a request, in this protocol version.
    Use { proto: u32 },
    /// This agent is leaving: start a new agent.
    Replace,
    /// This control request cannot be served.
    Refuse(String),
}

/// The agent's hello.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHello {
    pub build: String,
    pub pid: u32,
    pub endpoint: EndpointId,
    pub streams: usize,
    pub retiring: bool,
    pub action: Action,
}

/// The agent's state, as [`decide`] sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentView {
    pub proto_min: u32,
    pub proto_max: u32,
    pub build: String,
    pub config: String,
    /// Open streams, not counting the client that is asking.
    pub streams: usize,
    pub draining: bool,
}

/// The agent's answer to a hello, and what the agent does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    /// The agent exits when its last stream ends.
    pub retire: bool,
    /// The agent stops taking clients now, and exits when its streams end.
    pub drain: bool,
}

/// Decides how the agent answers a hello. The rules:
///
/// - Same build, a common protocol and the same config: use this agent.
/// - Another build, a common protocol and the same config: if the agent
///   has open streams, use it, and retire it after its last stream. A
///   second agent would hold the same endpoint key, and the relay gives
///   relayed packets only to the newest holder, so it could cut a live
///   relayed session. With no open streams, replace it at once.
/// - No common protocol, or another config: replace it. It drains while
///   the new agent starts. This is the only case with two agents at once.
/// - Control clients never change the agent's state.
pub fn decide(agent: &AgentView, hello: &ClientHello) -> Decision {
    let common = hello.proto_max.min(agent.proto_max);
    let proto = (common >= hello.proto_min.max(agent.proto_min)).then_some(common);
    let keep = |action| Decision {
        action,
        retire: false,
        drain: false,
    };
    let Some(config) = &hello.config else {
        return keep(match proto {
            _ if agent.draining => Action::Refuse("the agent is stopping".into()),
            Some(proto) => Action::Use { proto },
            None => Action::Refuse("no common protocol version".into()),
        });
    };
    let replace = Decision {
        action: Action::Replace,
        retire: false,
        drain: true,
    };
    match proto {
        _ if agent.draining => replace,
        Some(_) if *config != agent.config => replace,
        None => replace,
        Some(proto) if hello.build == agent.build => keep(Action::Use { proto }),
        Some(_) if agent.streams == 0 => replace,
        Some(proto) => Decision {
            action: Action::Use { proto },
            retire: true,
            drain: false,
        },
    }
}

/// A request after `action use`.
#[derive(Debug, Clone)]
pub enum Request {
    /// Open a stream to `target` on a host.
    Connect { host: HostAddrArgs, target: Target },
    /// Stop taking clients, and exit when the open streams end.
    Stop,
}

/// The agent's answer to a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Ok,
    Error(String),
}

pub async fn write_client_hello<W: AsyncWrite + Unpin>(w: &mut W, h: &ClientHello) -> Result<()> {
    frame::write(w, encode_client_hello(h).as_bytes(), MAX_FRAME).await
}

pub async fn read_client_hello<R: AsyncRead + Unpin>(r: &mut R) -> Result<ClientHello> {
    parse_client_hello(&frame::read(r, MAX_FRAME).await?)
}

pub async fn write_agent_hello<W: AsyncWrite + Unpin>(w: &mut W, h: &AgentHello) -> Result<()> {
    frame::write(w, encode_agent_hello(h).as_bytes(), MAX_FRAME).await
}

pub async fn read_agent_hello<R: AsyncRead + Unpin>(r: &mut R) -> Result<AgentHello> {
    parse_agent_hello(&frame::read(r, MAX_FRAME).await?)
}

pub async fn write_request<W: AsyncWrite + Unpin>(w: &mut W, req: &Request) -> Result<()> {
    frame::write(w, encode_request(req)?.as_bytes(), MAX_FRAME).await
}

pub async fn read_request<R: AsyncRead + Unpin>(r: &mut R) -> Result<Request> {
    parse_request(&frame::read(r, MAX_FRAME).await?)
}

pub async fn write_reply<W: AsyncWrite + Unpin>(w: &mut W, reply: &Reply) -> Result<()> {
    let body = match reply {
        Reply::Ok => "ok".to_string(),
        Reply::Error(detail) => format!("error {}", one_line(detail)),
    };
    frame::write(w, body.as_bytes(), MAX_FRAME).await
}

pub async fn read_reply<R: AsyncRead + Unpin>(r: &mut R) -> Result<Reply> {
    let body = frame::read(r, MAX_FRAME).await?;
    let text = std::str::from_utf8(&body).context("reply is not UTF-8")?;
    match text.split_once(' ').unwrap_or((text, "")) {
        ("ok", _) => Ok(Reply::Ok),
        ("error", detail) => Ok(Reply::Error(detail.to_string())),
        _ => bail!("unknown reply {text:?}"),
    }
}

fn encode_client_hello(h: &ClientHello) -> String {
    let mut s = format!(
        "hello client\nproto-min {}\nproto-max {}\nbuild {}\n",
        h.proto_min,
        h.proto_max,
        one_line(&h.build)
    );
    if let Some(config) = &h.config {
        s.push_str(&format!("config {}\n", one_line(config)));
    }
    s
}

fn parse_client_hello(body: &[u8]) -> Result<ClientHello> {
    let fields = frame::lines(body)?;
    expect_hello(&fields, "client")?;
    Ok(ClientHello {
        proto_min: field(&fields, "proto-min")?.parse()?,
        proto_max: field(&fields, "proto-max")?.parse()?,
        build: field(&fields, "build")?.to_string(),
        config: optional(&fields, "config").map(str::to_string),
    })
}

fn encode_agent_hello(h: &AgentHello) -> String {
    let action = match &h.action {
        Action::Use { proto } => format!("use {proto}"),
        Action::Replace => "replace".to_string(),
        Action::Refuse(detail) => format!("refuse {}", one_line(detail)),
    };
    format!(
        "hello agent\nbuild {}\npid {}\nendpoint {}\nstreams {}\nretiring {}\naction {action}\n",
        one_line(&h.build),
        h.pid,
        h.endpoint,
        h.streams,
        h.retiring
    )
}

fn parse_agent_hello(body: &[u8]) -> Result<AgentHello> {
    let fields = frame::lines(body)?;
    expect_hello(&fields, "agent")?;
    let action = field(&fields, "action")?;
    let action = match action.split_once(' ').unwrap_or((action, "")) {
        ("use", proto) => Action::Use {
            proto: proto.parse().context("bad protocol in action")?,
        },
        ("replace", _) => Action::Replace,
        ("refuse", detail) => Action::Refuse(detail.to_string()),
        _ => bail!("unknown action {action:?}"),
    };
    Ok(AgentHello {
        build: field(&fields, "build")?.to_string(),
        pid: field(&fields, "pid")?.parse()?,
        endpoint: field(&fields, "endpoint")?.parse()?,
        streams: field(&fields, "streams")?.parse()?,
        retiring: field(&fields, "retiring")?.parse()?,
        action,
    })
}

fn encode_request(req: &Request) -> Result<String> {
    Ok(match req {
        Request::Stop => "op stop\n".to_string(),
        Request::Connect { host, target } => {
            let mut s = format!("op connect\nhost {}\n", host.host_id);
            if let Some(relay) = &host.host_relay {
                s.push_str(&format!("relay {relay}\n"));
            }
            for addr in &host.host_addr {
                s.push_str(&format!("addr {addr}\n"));
            }
            s.push_str(&format!("target {target}\n"));
            s
        }
    })
}

fn parse_request(body: &[u8]) -> Result<Request> {
    let fields = frame::lines(body)?;
    match field(&fields, "op")? {
        "stop" => Ok(Request::Stop),
        "connect" => {
            let host = HostAddrArgs {
                host_id: field(&fields, "host")?.parse().context("bad host id")?,
                host_relay: optional(&fields, "relay")
                    .map(str::parse::<RelayUrl>)
                    .transpose()
                    .context("bad relay URL")?,
                host_addr: fields
                    .iter()
                    .filter(|(k, _)| *k == "addr")
                    .map(|(_, v)| v.parse::<SocketAddr>())
                    .collect::<Result<_, _>>()
                    .context("bad host address")?,
            };
            let target = field(&fields, "target")?.parse()?;
            Ok(Request::Connect { host, target })
        }
        op => bail!("unknown op {op:?}"),
    }
}

fn expect_hello(fields: &[(&str, &str)], who: &str) -> Result<()> {
    match fields.first() {
        Some(("hello", w)) if *w == who => Ok(()),
        _ => bail!("expected a {who} hello"),
    }
}

fn field<'a>(fields: &[(&str, &'a str)], key: &str) -> Result<&'a str> {
    optional(fields, key).ok_or_else(|| anyhow!("missing field {key:?}"))
}

fn optional<'a>(fields: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// Keeps a value on one line, so it cannot add fields.
fn one_line(s: &str) -> String {
    s.replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> AgentView {
        AgentView {
            proto_min: 1,
            proto_max: 1,
            build: "1.0.0".into(),
            config: "cfg".into(),
            streams: 0,
            draining: false,
        }
    }

    fn hello(proto: (u32, u32), build: &str, config: Option<&str>) -> ClientHello {
        ClientHello {
            proto_min: proto.0,
            proto_max: proto.1,
            build: build.into(),
            config: config.map(str::to_string),
        }
    }

    fn use_(proto: u32, retire: bool) -> Decision {
        Decision {
            action: Action::Use { proto },
            retire,
            drain: false,
        }
    }

    fn replace() -> Decision {
        Decision {
            action: Action::Replace,
            retire: false,
            drain: true,
        }
    }

    #[test]
    fn same_build_uses_the_agent() {
        assert_eq!(
            decide(&view(), &hello((1, 1), "1.0.0", Some("cfg"))),
            use_(1, false)
        );
    }

    #[test]
    fn version_handshake_picks_the_highest_common_protocol() {
        let agent = AgentView {
            proto_min: 1,
            proto_max: 3,
            ..view()
        };
        assert_eq!(
            decide(&agent, &hello((2, 5), "1.0.0", Some("cfg"))),
            use_(3, false)
        );
        assert_eq!(
            decide(&agent, &hello((1, 2), "1.0.0", Some("cfg"))),
            use_(2, false)
        );
        assert_eq!(
            decide(&agent, &hello((4, 5), "1.0.0", Some("cfg"))),
            replace()
        );
    }

    #[test]
    fn another_build_with_live_streams_retires_the_agent_later() {
        let busy = AgentView {
            streams: 2,
            ..view()
        };
        assert_eq!(
            decide(&busy, &hello((1, 1), "1.1.0", Some("cfg"))),
            use_(1, true)
        );
    }

    #[test]
    fn another_build_with_no_streams_replaces_the_agent_now() {
        assert_eq!(
            decide(&view(), &hello((1, 1), "1.1.0", Some("cfg"))),
            replace()
        );
    }

    #[test]
    fn another_config_or_protocol_replaces_even_a_busy_agent() {
        let busy = AgentView {
            streams: 1,
            ..view()
        };
        assert_eq!(
            decide(&busy, &hello((1, 1), "1.0.0", Some("other"))),
            replace()
        );
        assert_eq!(
            decide(&busy, &hello((2, 2), "1.0.0", Some("cfg"))),
            replace()
        );
    }

    #[test]
    fn a_draining_agent_sends_every_client_away() {
        let draining = AgentView {
            draining: true,
            ..view()
        };
        assert_eq!(
            decide(&draining, &hello((1, 1), "1.0.0", Some("cfg"))),
            replace()
        );
        assert!(matches!(
            decide(&draining, &hello((1, 1), "1.0.0", None)).action,
            Action::Refuse(_)
        ));
    }

    #[test]
    fn control_clients_never_change_the_agent() {
        let d = decide(&view(), &hello((1, 1), "9.9.9", None));
        assert_eq!(d, use_(1, false));
        let d = decide(&view(), &hello((7, 7), "1.0.0", None));
        assert!(matches!(d.action, Action::Refuse(_)));
        assert!(!d.drain && !d.retire);
    }

    #[test]
    fn hellos_round_trip() {
        let client = hello((1, 2), "1.0.0", Some("--key-file /k --relay n0"));
        let body = encode_client_hello(&client);
        assert_eq!(parse_client_hello(body.as_bytes()).unwrap(), client);

        let endpoint = iroh::SecretKey::generate().public();
        for action in [
            Action::Use { proto: 1 },
            Action::Replace,
            Action::Refuse("no common protocol version".into()),
        ] {
            let agent = AgentHello {
                build: "1.0.0".into(),
                pid: 42,
                endpoint,
                streams: 3,
                retiring: true,
                action,
            };
            let body = encode_agent_hello(&agent);
            assert_eq!(parse_agent_hello(body.as_bytes()).unwrap(), agent);
        }
    }

    #[test]
    fn hellos_ignore_unknown_fields_and_refuse_the_wrong_side() {
        let body = b"hello client\nproto-min 1\nproto-max 1\nbuild x\nfuture y\n";
        assert_eq!(parse_client_hello(body).unwrap().build, "x");
        assert!(parse_client_hello(b"hello agent\nproto-min 1\n").is_err());
        assert!(parse_client_hello(b"hello client\nproto-max 1\nbuild x\n").is_err());
    }

    #[test]
    fn a_value_cannot_add_a_field() {
        let client = hello((1, 1), "1.0.0\nconfig injected", None);
        let parsed = parse_client_hello(encode_client_hello(&client).as_bytes()).unwrap();
        assert_eq!(parsed.config, None);
    }

    #[test]
    fn requests_round_trip_and_refuse_bad_input() {
        let host_id = iroh::SecretKey::generate().public();
        let req = Request::Connect {
            host: HostAddrArgs {
                host_id,
                host_relay: Some("https://relay.example/".parse().unwrap()),
                host_addr: vec!["127.0.0.1:5000".parse().unwrap()],
            },
            target: "rig:r1:22".parse().unwrap(),
        };
        let parsed = parse_request(encode_request(&req).unwrap().as_bytes()).unwrap();
        let Request::Connect { host, target } = parsed else {
            panic!("expected a connect request");
        };
        assert_eq!(host.host_id, host_id);
        assert_eq!(
            host.host_relay.unwrap().to_string(),
            "https://relay.example/"
        );
        assert_eq!(host.host_addr, vec!["127.0.0.1:5000".parse().unwrap()]);
        assert_eq!(target.to_string(), "rig:r1:22");

        assert!(matches!(
            parse_request(b"op stop\n").unwrap(),
            Request::Stop
        ));
        assert!(parse_request(b"op launch\n").is_err());
        assert!(parse_request(b"op connect\nhost nope\ntarget hostd\n").is_err());
        let no_target = format!("op connect\nhost {host_id}\n");
        assert!(parse_request(no_target.as_bytes()).is_err());
    }

    #[tokio::test]
    async fn replies_round_trip_over_frames() {
        for reply in [Reply::Ok, Reply::Error("dial failed: timed out".into())] {
            let mut wire = Vec::new();
            write_reply(&mut wire, &reply).await.unwrap();
            assert_eq!(read_reply(&mut &wire[..]).await.unwrap(), reply);
        }
    }
}
