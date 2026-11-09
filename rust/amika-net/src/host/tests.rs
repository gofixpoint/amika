//! The host role against a fake hostd on its control socket, in one
//! process, with no relay: a client endpoint dials the host's loopback
//! address.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use iroh::{Endpoint, SecretKey, endpoint::Connection};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, UnixListener, unix::OwnedWriteHalf},
    task::JoinHandle,
};

use super::{Authority, Control, Registry, serve};
use crate::{
    VERSION,
    connect::{self, HostAddrArgs},
    header::{ALPN, Target},
    net::{self, EndpointArgs, RelayChoice, Relays},
};

const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn a_refused_peer_gets_no_stream() {
    let bed = Bed::new("refused").await;
    let ready = bed.hostd.wait_for("ready", 1).await.remove(0);
    assert_eq!(ready["endpoint_id"], bed.host.id().to_string());
    assert_eq!(ready["version"], VERSION);
    assert!(ready["relay_url"].is_null(), "no relay: {ready}");

    let conn = bed.client.dial(&bed.host).await.unwrap();
    let err = open(&conn, "rig:r1:7").await.unwrap_err();
    assert!(err.contains("caller not allowed"), "{err}");
    let checks = bed.hostd.wait_for("check_peer", 1).await;
    assert_eq!(checks[0]["endpoint_id"], bed.client.id());
    assert!(checks[0]["id"].is_string());
    assert_eq!(bed.hostd.count("open"), 0);
}

#[tokio::test]
async fn an_allowed_stream_reaches_the_target() {
    let bed = Bed::new("allowed").await;
    bed.hostd.allow(&bed.client.id());
    let conn = bed.client.dial(&bed.host).await.unwrap();
    for _ in 0..3 {
        let (mut send, mut recv) = connect::open_target(&conn, &rig(7)).await.unwrap();
        echo(&mut send, &mut recv, b"hello").await;
    }
    // Check 1 runs once for each connection, check 2 once for each stream.
    let opens = bed.hostd.wait_for("open", 3).await;
    assert_eq!(bed.hostd.count("check_peer"), 1);
    assert_eq!(opens[0]["target"], "rig:r1:7");
    assert_eq!(opens[0]["endpoint_id"], bed.client.id());
}

#[tokio::test]
async fn a_refused_target_gets_the_reason() {
    let bed = Bed::new("target").await;
    bed.hostd.allow(&bed.client.id());
    bed.hostd.answer(
        "rig:r1:8",
        json!({ "ok": false, "reason": "port_not_allowed" }),
    );
    bed.hostd
        .answer("hostd", json!({ "ok": false, "reason": "not_allowed" }));
    bed.hostd
        .answer("rig:r1:9", json!({ "ok": true, "connect": "10.0.0.1:22" }));
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_addr = closed.local_addr().unwrap();
    drop(closed);
    bed.hostd.answer(
        "rig:r1:10",
        json!({ "ok": true, "connect": closed_addr.to_string() }),
    );
    let conn = bed.client.dial(&bed.host).await.unwrap();
    for (target, reason) in [
        ("rig:r1:8", "port_not_allowed"),
        ("rig:r2:22", "unknown_rig"),
        ("hostd", "not_allowed"),
        ("rig:r1:9", "unreachable"),
        ("rig:r1:10", "unreachable"),
    ] {
        let err = open(&conn, target).await.unwrap_err();
        assert!(err.ends_with(&format!("{target}: {reason}")), "{err}");
    }
    // The refusals did not end the connection.
    let (mut send, mut recv) = connect::open_target(&conn, &rig(7)).await.unwrap();
    echo(&mut send, &mut recv, b"still here").await;
}

#[tokio::test]
async fn a_bad_header_resets_the_stream() {
    let bed = Bed::new("header").await;
    bed.hostd.allow(&bed.client.id());
    let conn = bed.client.dial(&bed.host).await.unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(b"version 9\ntarget hostd\n\n")
        .await
        .unwrap();
    let read = tokio::time::timeout(WAIT, recv.read_to_end(1024)).await;
    assert!(read.unwrap().is_err(), "the stream must be reset");
    assert_eq!(bed.hostd.count("open"), 0);
}

#[tokio::test]
async fn revoke_closes_the_connection() {
    let bed = Bed::new("revoke").await;
    bed.hostd.allow(&bed.client.id());
    let conn = bed.client.dial(&bed.host).await.unwrap();
    let (mut send, mut recv) = connect::open_target(&conn, &rig(7)).await.unwrap();
    echo(&mut send, &mut recv, b"before").await;

    bed.hostd
        .send(json!({ "type": "revoke", "endpoint_ids": [bed.client.id()] }))
        .await;
    let reason = tokio::time::timeout(WAIT, conn.closed()).await.unwrap();
    assert!(reason.to_string().contains("access revoked"), "{reason}");
    let mut buf = [0u8; 1];
    assert!(recv.read_exact(&mut buf).await.is_err());
}

#[tokio::test]
async fn a_lost_control_socket_refuses_new_streams_until_hostd_is_back() {
    let mut bed = Bed::new("lost").await;
    bed.hostd.allow(&bed.client.id());
    let conn = bed.client.dial(&bed.host).await.unwrap();
    let (mut send, mut recv) = connect::open_target(&conn, &rig(7)).await.unwrap();
    echo(&mut send, &mut recv, b"before").await;

    let policy = bed.hostd.stop().await;
    // The host sees the socket close at once. A new stream is refused.
    let mut refused = None;
    for _ in 0..50 {
        match open(&conn, "rig:r1:7").await {
            Err(e) => {
                refused = Some(e);
                break;
            }
            Ok(()) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let refused = refused.expect("a stream opened with no hostd");
    assert!(refused.ends_with("rig:r1:7: unreachable"), "{refused}");
    // So is a new connection.
    let conn2 = bed.client.dial(&bed.host).await.unwrap();
    let err = open(&conn2, "rig:r1:7").await.unwrap_err();
    assert!(err.contains("host not ready"), "{err}");
    // An open stream goes on.
    echo(&mut send, &mut recv, b"during").await;

    // The host connects again when hostd is back.
    bed.hostd = FakeHostd::listen(&bed.socket, policy);
    let ready = bed.hostd.wait_for("ready", 1).await.remove(0);
    assert_eq!(ready["endpoint_id"], bed.host.id().to_string());
    open(&conn, "rig:r1:7").await.unwrap();
    let conn3 = bed.client.dial(&bed.host).await.unwrap();
    let (mut send3, mut recv3) = connect::open_target(&conn3, &rig(7)).await.unwrap();
    echo(&mut send3, &mut recv3, b"after").await;
}

/// A host role with a fake hostd, a client endpoint, and an echo server
/// that the fake hostd names for `rig:r1:7`.
struct Bed {
    socket: PathBuf,
    hostd: FakeHostd,
    host: Endpoint,
    client: Client,
    _serve: JoinHandle<()>,
}

impl Bed {
    async fn new(name: &str) -> Self {
        // Short: a Unix socket path has a limit of about 100 bytes.
        let dir = std::env::temp_dir().join(format!("anh-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("hostd.sock");
        let policy = Arc::new(Mutex::new(Policy::default()));
        let echo = start_echo_server().await;
        policy.lock().unwrap().answers.insert(
            "rig:r1:7".into(),
            json!({ "ok": true, "connect": echo.to_string() }),
        );
        let hostd = FakeHostd::listen(&socket, policy);

        let (host, _) = endpoint(vec![ALPN.to_vec()]).await;
        let registry = Registry::new();
        let control = Control::start(socket.clone(), host.clone(), registry.clone());
        let serve = tokio::spawn(serve(host.clone(), Authority::Hostd(control), registry));
        let (ep, relays) = endpoint(vec![]).await;
        Self {
            socket,
            hostd,
            host,
            client: Client { ep, relays },
            _serve: serve,
        }
    }
}

struct Client {
    ep: Endpoint,
    relays: Relays,
}

impl Client {
    fn id(&self) -> String {
        self.ep.id().to_string()
    }

    async fn dial(&self, host: &Endpoint) -> anyhow::Result<Connection> {
        let addr = host
            .bound_sockets()
            .into_iter()
            .find(|a| a.is_ipv4())
            .unwrap();
        let host = HostAddrArgs {
            endpoint: host.id(),
            relay_url: None,
            direct_addrs: vec![addr],
        };
        connect::dial(&self.ep, &self.relays, &host).await
    }
}

/// What the fake hostd answers.
#[derive(Default)]
struct Policy {
    allowed: HashSet<String>,
    /// The `open` answer for each target, without the id.
    answers: HashMap<String, Value>,
}

/// A fake hostd: it listens on the control socket, records each message,
/// and answers from its policy. It serves one connection at a time.
struct FakeHostd {
    path: PathBuf,
    policy: Arc<Mutex<Policy>>,
    seen: Arc<Mutex<Vec<Value>>>,
    writer: Arc<tokio::sync::Mutex<Option<OwnedWriteHalf>>>,
    task: JoinHandle<()>,
}

impl FakeHostd {
    fn listen(path: &Path, policy: Arc<Mutex<Policy>>) -> Self {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(tokio::sync::Mutex::new(None));
        let task = tokio::spawn({
            let (policy, seen, writer) = (policy.clone(), seen.clone(), writer.clone());
            async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let (r, w) = stream.into_split();
                    *writer.lock().await = Some(w);
                    let mut lines = BufReader::new(r).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let msg: Value = serde_json::from_str(&line).unwrap();
                        let reply = answer(&policy.lock().unwrap(), &msg);
                        seen.lock().unwrap().push(msg);
                        if let Some(reply) = reply {
                            let mut line = reply.to_string();
                            line.push('\n');
                            let mut w = writer.lock().await;
                            w.as_mut()
                                .unwrap()
                                .write_all(line.as_bytes())
                                .await
                                .unwrap();
                        }
                    }
                }
            }
        });
        Self {
            path: path.to_path_buf(),
            policy,
            seen,
            writer,
            task,
        }
    }

    fn allow(&self, id: &str) {
        self.policy.lock().unwrap().allowed.insert(id.into());
    }

    fn answer(&self, target: &str, reply: Value) {
        self.policy
            .lock()
            .unwrap()
            .answers
            .insert(target.into(), reply);
    }

    async fn send(&self, msg: Value) {
        let mut line = msg.to_string();
        line.push('\n');
        let mut w = self.writer.lock().await;
        w.as_mut()
            .unwrap()
            .write_all(line.as_bytes())
            .await
            .unwrap();
    }

    fn count(&self, kind: &str) -> usize {
        self.of(kind).len()
    }

    fn of(&self, kind: &str) -> Vec<Value> {
        let seen = self.seen.lock().unwrap();
        seen.iter().filter(|m| m["type"] == kind).cloned().collect()
    }

    /// Waits until hostd has seen `n` messages of `kind`, and returns them.
    async fn wait_for(&self, kind: &str, n: usize) -> Vec<Value> {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let found = self.of(kind);
            if found.len() >= n {
                return found;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "hostd saw {} {kind} messages, not {n}",
                found.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Stops listening and closes the connection, as when hostd exits.
    /// Returns the policy, for the next fake hostd.
    async fn stop(&mut self) -> Arc<Mutex<Policy>> {
        self.task.abort();
        self.writer.lock().await.take();
        let _ = std::fs::remove_file(&self.path);
        self.policy.clone()
    }
}

impl Drop for FakeHostd {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn answer(policy: &Policy, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    match msg["type"].as_str()? {
        "check_peer" => {
            let allowed = policy.allowed.contains(msg["endpoint_id"].as_str()?);
            Some(json!({
                "id": id,
                "allowed": allowed,
                "kind": "device",
                "principal": { "kind": "user", "id": "user_1" },
            }))
        }
        "open" => {
            let mut reply = policy
                .answers
                .get(msg["target"].as_str()?)
                .cloned()
                .unwrap_or(json!({ "ok": false, "reason": "unknown_rig" }));
            reply["id"] = id;
            Some(reply)
        }
        _ => None,
    }
}

async fn endpoint(alpns: Vec<Vec<u8>>) -> (Endpoint, Relays) {
    let args = EndpointArgs {
        relay: Some(RelayChoice::None),
        bind: Some("127.0.0.1:0".into()),
        ..EndpointArgs::default()
    };
    let secret = SecretKey::generate();
    let relays = Relays::new(&args, RelayChoice::None, &secret).unwrap();
    let ep = net::builder(&args, &relays, &[], secret)
        .await
        .unwrap()
        .alpns(alpns)
        .bind()
        .await
        .unwrap();
    (ep, relays)
}

fn rig(port: u16) -> Target {
    Target::Rig {
        id: "r1".into(),
        port,
    }
}

/// Opens a stream to `target`, and closes it at once.
async fn open(conn: &Connection, target: &str) -> Result<(), String> {
    let target: Target = target.parse().unwrap();
    match connect::open_target(conn, &target).await {
        Ok((mut send, _recv)) => {
            let _ = send.finish();
            Ok(())
        }
        Err(e) => Err(format!("{e:#}")),
    }
}

async fn echo(
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    msg: &[u8],
) {
    send.write_all(msg).await.unwrap();
    let mut buf = vec![0u8; msg.len()];
    tokio::time::timeout(WAIT, recv.read_exact(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(buf, msg);
}

async fn start_echo_server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = conn.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}
