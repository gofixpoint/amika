//! The control socket to hostd.
//!
//! hostd listens on a Unix socket in its state directory, and the host role
//! connects to it. Messages are JSON, one per line. A request has an `id`,
//! a string, and its response has the same `id`.
//!
//! From the host role to hostd:
//!
//! - `ready { endpoint_id, relay_url, version }`, after each connect.
//!   `relay_url` is null until the endpoint has a home relay.
//! - `home_relay { relay_url }`, when the home relay changes.
//! - `check_peer { id, endpoint_id }`, check 1. The response is
//!   `{ id, allowed, kind, principal?, service? }`.
//! - `open { id, endpoint_id, target }`, check 2. The response is
//!   `{ id, ok: true, connect: "127.0.0.1:<port>" }` or
//!   `{ id, ok: false, reason }`.
//!
//! From hostd to the host role:
//!
//! - `revoke { endpoint_ids }`: close every connection from these
//!   endpoints at once.
//!
//! While the socket is closed, the host refuses new connections and streams,
//! and connects again with a backoff.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use iroh::{Endpoint, EndpointId, RelayUrl, Watcher};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::{mpsc, oneshot},
};
use tracing::{debug, info, warn};

use super::{Caller, PeerCheck, registry::Registry};
use crate::{
    VERSION,
    header::{Refusal, Target},
};

/// How long hostd may take to answer a request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The first wait before connecting again.
const MIN_BACKOFF: Duration = Duration::from_millis(100);
/// The longest wait before connecting again.
const MAX_BACKOFF: Duration = Duration::from_secs(2);
/// The longest line the host role reads from hostd.
const MAX_LINE: u64 = 64 * 1024;

/// The host role's side of the control socket.
pub struct Control {
    path: PathBuf,
    ep: Endpoint,
    registry: Arc<Registry>,
    link: Mutex<Link>,
}

#[derive(Default)]
struct Link {
    /// Lines to hostd. `None` while the socket is closed.
    tx: Option<mpsc::UnboundedSender<String>>,
    /// Requests that wait for a response, by id.
    pending: HashMap<String, oneshot::Sender<Value>>,
    next_id: u64,
    /// The home relay that hostd last heard about.
    relay: Option<RelayUrl>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outgoing {
    Ready {
        endpoint_id: String,
        relay_url: Option<String>,
        version: &'static str,
    },
    HomeRelay {
        relay_url: String,
    },
    CheckPeer {
        id: String,
        endpoint_id: String,
    },
    Open {
        id: String,
        endpoint_id: String,
        target: String,
    },
}

#[derive(Deserialize)]
struct CheckPeerReply {
    allowed: bool,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    principal: Option<Principal>,
    #[serde(default)]
    service: Option<String>,
}

#[derive(Deserialize)]
struct Principal {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
struct OpenReply {
    ok: bool,
    #[serde(default)]
    connect: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct Revoke {
    endpoint_ids: Vec<String>,
}

impl Control {
    /// Starts connecting to hostd at `path`, and keeps connecting while the
    /// process runs.
    pub fn start(path: PathBuf, ep: Endpoint, registry: Arc<Registry>) -> Arc<Self> {
        let control = Arc::new(Self {
            path,
            ep,
            registry,
            link: Mutex::default(),
        });
        tokio::spawn(control.clone().run());
        tokio::spawn(control.clone().watch_relay());
        control
    }

    /// Check 1: asks hostd whether `peer` may connect.
    pub async fn check_peer(&self, peer: EndpointId) -> PeerCheck {
        let reply = self
            .request(|id| Outgoing::CheckPeer {
                id,
                endpoint_id: peer.to_string(),
            })
            .await;
        let reply = match reply {
            Ok(v) => v,
            Err(why) => return PeerCheck::Unavailable(why),
        };
        match serde_json::from_value::<CheckPeerReply>(reply) {
            Ok(r) if r.allowed => PeerCheck::Allowed(Caller {
                kind: r.kind.unwrap_or_default(),
                principal: r.principal.map(|p| format!("{}:{}", p.kind, p.id)),
                service: r.service,
            }),
            Ok(_) => PeerCheck::Refused,
            Err(e) => PeerCheck::Unavailable(format!("bad check_peer response: {e}")),
        }
    }

    /// Check 2: asks hostd where `target` is for `peer`.
    pub async fn open(&self, peer: EndpointId, target: &Target) -> Result<SocketAddr, Refusal> {
        let reply = self
            .request(|id| Outgoing::Open {
                id,
                endpoint_id: peer.to_string(),
                target: target.to_string(),
            })
            .await;
        let reply = match reply {
            Ok(v) => v,
            Err(why) => {
                warn!(%peer, %target, %why, "cannot ask hostd for the target");
                return Err(Refusal::Unreachable);
            }
        };
        let reply = match serde_json::from_value::<OpenReply>(reply) {
            Ok(r) => r,
            Err(e) => {
                warn!(%target, error = %e, "bad open response");
                return Err(Refusal::Unreachable);
            }
        };
        if !reply.ok {
            let reason = reply.reason.unwrap_or_default();
            return Err(reason.parse().unwrap_or_else(|_| {
                warn!(%target, %reason, "unknown refusal reason from hostd; sending not_allowed");
                Refusal::NotAllowed
            }));
        }
        let connect = reply.connect.unwrap_or_default();
        connect.parse().map_err(|_| {
            warn!(%target, %connect, "bad connect address from hostd");
            Refusal::Unreachable
        })
    }

    /// Sends a request and waits for its response. `Err` says why there is
    /// no response.
    async fn request(&self, make: impl FnOnce(String) -> Outgoing) -> Result<Value, String> {
        let (id, rx) = {
            let mut link = self.link.lock().expect("poisoned");
            let Some(tx) = link.tx.clone() else {
                return Err("hostd is not connected".into());
            };
            link.next_id += 1;
            let id = link.next_id.to_string();
            let (reply_tx, reply_rx) = oneshot::channel();
            link.pending.insert(id.clone(), reply_tx);
            if tx.send(encode(&make(id.clone()))).is_err() {
                link.pending.remove(&id);
                return Err("hostd is not connected".into());
            }
            (id, reply_rx)
        };
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("the control socket closed".into()),
            Err(_) => {
                self.link.lock().expect("poisoned").pending.remove(&id);
                Err(format!("hostd did not answer in {REQUEST_TIMEOUT:?}"))
            }
        }
    }

    /// Connects to hostd, serves the socket until it closes, and connects
    /// again, forever.
    async fn run(self: Arc<Self>) {
        let mut backoff = MIN_BACKOFF;
        let mut failures = 0u32;
        loop {
            match UnixStream::connect(&self.path).await {
                Ok(stream) => {
                    info!(socket = %self.path.display(), "connected to hostd");
                    backoff = MIN_BACKOFF;
                    failures = 0;
                    self.session(stream).await;
                    warn!(
                        "the control socket closed; refusing new connections until hostd is back"
                    );
                }
                Err(e) => {
                    failures += 1;
                    if failures == 1 {
                        warn!(socket = %self.path.display(), error = %e, "cannot connect to hostd; retrying");
                    } else {
                        debug!(error = %e, failures, "cannot connect to hostd");
                    }
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// Serves one socket: sends `ready`, then reads hostd's messages until
    /// the socket closes. Then fails every request that waits.
    async fn session(&self, stream: UnixStream) {
        let (r, mut w) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut link = self.link.lock().expect("poisoned");
            let relay = self.ep.addr().relay_urls().next().cloned();
            let ready = Outgoing::Ready {
                endpoint_id: self.ep.id().to_string(),
                relay_url: relay.as_ref().map(ToString::to_string),
                version: VERSION,
            };
            link.relay = relay;
            let _ = tx.send(encode(&ready));
            link.tx = Some(tx);
        }
        let writer = async {
            while let Some(line) = rx.recv().await {
                if let Err(e) = w.write_all(line.as_bytes()).await {
                    info!(error = %e, "writing to hostd failed");
                    return;
                }
            }
        };
        let reader = async {
            let mut reader = BufReader::new(r);
            let mut line = String::new();
            loop {
                line.clear();
                match (&mut reader).take(MAX_LINE).read_line(&mut line).await {
                    Ok(0) => return,
                    Ok(_) if !line.ends_with('\n') => {
                        warn!("a line from hostd is too long; closing the socket");
                        return;
                    }
                    Ok(_) => self.handle(line.trim_end()),
                    Err(e) => {
                        info!(error = %e, "reading from hostd failed");
                        return;
                    }
                }
            }
        };
        tokio::select! {
            () = writer => {}
            () = reader => {}
        }
        let mut link = self.link.lock().expect("poisoned");
        link.tx = None;
        // Dropping the senders fails the requests that wait.
        link.pending.clear();
    }

    /// Handles one message from hostd: a response or a `revoke`.
    fn handle(&self, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "a message from hostd is not JSON");
                return;
            }
        };
        if msg.get("type").and_then(Value::as_str) == Some("revoke") {
            self.revoke(msg);
            return;
        }
        let Some(id) = response_id(&msg) else {
            warn!(r#type = ?msg.get("type"), "unknown message from hostd");
            return;
        };
        let waiter = self.link.lock().expect("poisoned").pending.remove(&id);
        match waiter {
            Some(tx) => {
                let _ = tx.send(msg);
            }
            None => debug!(%id, "a response with no request (late or unknown)"),
        }
    }

    fn revoke(&self, msg: Value) {
        let ids = match serde_json::from_value::<Revoke>(msg) {
            Ok(r) => r.endpoint_ids,
            Err(e) => {
                warn!(error = %e, "bad revoke message");
                return;
            }
        };
        let peers: Vec<EndpointId> = ids
            .iter()
            .filter_map(|id| match id.parse() {
                Ok(peer) => Some(peer),
                Err(_) => {
                    warn!(%id, "revoke names a bad endpoint id");
                    None
                }
            })
            .collect();
        let closed = self.registry.revoke(&peers);
        info!(endpoints = peers.len(), connections = closed, "revoked");
    }

    /// Tells hostd each new home relay.
    async fn watch_relay(self: Arc<Self>) {
        let mut addrs = self.ep.watch_addr().stream();
        while let Some(addr) = addrs.next().await {
            let Some(relay) = addr.relay_urls().next().cloned() else {
                continue;
            };
            let mut link = self.link.lock().expect("poisoned");
            if link.relay.as_ref() == Some(&relay) {
                continue;
            }
            info!(%relay, "home relay");
            if let Some(tx) = &link.tx {
                let _ = tx.send(encode(&Outgoing::HomeRelay {
                    relay_url: relay.to_string(),
                }));
            }
            link.relay = Some(relay);
        }
    }
}

/// A response's id: a string, or a number that hostd sent back as one.
fn response_id(msg: &Value) -> Option<String> {
    match msg.get("id")? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn encode(msg: &Outgoing) -> String {
    let mut line = serde_json::to_string(msg).expect("messages always encode");
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_encode_as_the_contract_says() {
        let ready = encode(&Outgoing::Ready {
            endpoint_id: "e".into(),
            relay_url: None,
            version: "1.2.3",
        });
        assert_eq!(
            ready,
            "{\"type\":\"ready\",\"endpoint_id\":\"e\",\"relay_url\":null,\"version\":\"1.2.3\"}\n"
        );
        let open = encode(&Outgoing::Open {
            id: "7".into(),
            endpoint_id: "e".into(),
            target: "rig:r1:22".into(),
        });
        assert_eq!(
            open,
            "{\"type\":\"open\",\"id\":\"7\",\"endpoint_id\":\"e\",\"target\":\"rig:r1:22\"}\n"
        );
        let home = encode(&Outgoing::HomeRelay {
            relay_url: "https://r/".into(),
        });
        assert_eq!(
            home,
            "{\"type\":\"home_relay\",\"relay_url\":\"https://r/\"}\n"
        );
    }

    #[test]
    fn a_response_id_may_be_a_string_or_a_number() {
        let id = |v: Value| response_id(&v);
        assert_eq!(id(serde_json::json!({ "id": "3" })), Some("3".into()));
        assert_eq!(id(serde_json::json!({ "id": 3 })), Some("3".into()));
        assert_eq!(id(serde_json::json!({ "type": "revoke" })), None);
    }
}
