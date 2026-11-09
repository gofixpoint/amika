//! One iroh connection for each host, and a stream to a target on it.
//!
//! A connection is dialed on first use and kept while it lives. Each
//! request opens its own QUIC stream on it, which costs no round trip. A
//! host's check 1 runs once per connection, and check 2 once per stream.
//!
//! Concurrent requests to a host that has no connection wait for one dial.
//! A connection with no open stream for `idle` is closed, so a dialer that
//! has served many hosts does not keep a connection to each of them.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, TransportAddr,
    endpoint::{Connection, RecvStream, SendStream},
};
use tracing::{info, warn};

use crate::stream_header::{self, ALPN, Refusal, Status};

/// Why the dialer could not open a stream to a target.
#[derive(Debug)]
pub enum OpenError {
    /// The dial did not finish in time.
    DialTimeout,
    /// The dial failed: the host is offline, or refused the dialer in
    /// check 1.
    Dial(String),
    /// The host refused the stream in check 2.
    Refused(Refusal),
    /// The connection or the stream failed after the dial.
    Stream(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::DialTimeout => f.write_str("dial timed out"),
            OpenError::Dial(e) => write!(f, "dial failed: {e}"),
            OpenError::Refused(r) => write!(f, "host refused the stream: {r}"),
            OpenError::Stream(e) => write!(f, "stream failed: {e}"),
        }
    }
}

/// A stream to a target, ready for bytes. The lease keeps the host's
/// connection from being closed as idle while the stream is in use.
pub struct TargetStream {
    pub send: SendStream,
    pub recv: RecvStream,
    pub lease: Lease,
    /// `direct`, `relay` or `none`: the connection's selected path when the
    /// stream opened.
    pub path: &'static str,
}

/// Counts one open stream on a host's connection until it is dropped.
pub struct Lease {
    host: Arc<Host>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.host.active.fetch_sub(1, Ordering::SeqCst);
        *self.host.last_used.lock().expect("poisoned") = Instant::now();
    }
}

#[derive(Debug, Clone)]
pub struct PoolOptions {
    /// The bound on one dial.
    pub dial_timeout: Duration,
    /// The bound on the host's answer to a stream header.
    pub status_timeout: Duration,
    /// How long a connection with no open stream stays.
    pub idle: Duration,
}

impl Default for PoolOptions {
    fn default() -> Self {
        Self {
            dial_timeout: Duration::from_secs(15),
            status_timeout: Duration::from_secs(10),
            idle: Duration::from_secs(600),
        }
    }
}

pub struct Pool {
    ep: Endpoint,
    options: PoolOptions,
    hosts: Mutex<HashMap<EndpointId, Arc<Host>>>,
}

struct Host {
    /// The live connection. Held across a dial, so concurrent callers wait
    /// for one dial.
    conn: tokio::sync::Mutex<Option<Connection>>,
    active: AtomicUsize,
    last_used: Mutex<Instant>,
}

impl Pool {
    pub fn new(ep: Endpoint, options: PoolOptions) -> Arc<Self> {
        Arc::new(Self {
            ep,
            options,
            hosts: Mutex::new(HashMap::new()),
        })
    }

    /// Opens a stream to `target` on the host `id`, and waits for `ok`.
    ///
    /// A reused connection can be dead before iroh notices. If the stream
    /// fails on one, the dialer dials once more and tries again.
    pub async fn open(
        &self,
        id: EndpointId,
        relay: Option<&RelayUrl>,
        target: &str,
    ) -> Result<TargetStream, OpenError> {
        let host = self.host(id);
        // Leased before the dial, so the reaper never closes a connection
        // that a request is about to use.
        host.active.fetch_add(1, Ordering::SeqCst);
        let lease = Lease { host: host.clone() };
        let (conn, fresh) = self.connection(&host, id, relay).await?;
        match self.open_on(&conn, target).await {
            Err(OpenError::Stream(e)) if !fresh => {
                info!(host = %id, error = %e, "stream failed on a kept connection; dialing again");
                let mut slot = host.conn.lock().await;
                if slot
                    .as_ref()
                    .is_some_and(|c| c.stable_id() == conn.stable_id())
                {
                    *slot = None;
                }
                drop(slot);
                let (conn, _) = self.connection(&host, id, relay).await?;
                self.open_on(&conn, target)
                    .await
                    .map(|(send, recv)| TargetStream {
                        send,
                        recv,
                        lease,
                        path: path_kind(&conn),
                    })
            }
            result => result.map(|(send, recv)| TargetStream {
                send,
                recv,
                lease,
                path: path_kind(&conn),
            }),
        }
    }

    /// Closes connections that have had no open stream for the idle time,
    /// and forgets closed ones. Runs until the endpoint closes.
    pub async fn reap(self: Arc<Self>) {
        let mut tick = tokio::time::interval(self.options.idle.min(Duration::from_secs(60)));
        loop {
            tick.tick().await;
            if self.ep.is_closed() {
                return;
            }
            self.reap_once().await;
        }
    }

    /// One pass of [`Pool::reap`].
    pub async fn reap_once(&self) {
        let hosts: Vec<(EndpointId, Arc<Host>)> = self
            .hosts
            .lock()
            .expect("poisoned")
            .iter()
            .map(|(id, h)| (*id, h.clone()))
            .collect();
        for (id, host) in hosts {
            let idle_for = host.last_used.lock().expect("poisoned").elapsed();
            if host.active.load(Ordering::SeqCst) > 0 || idle_for < self.options.idle {
                continue;
            }
            // A host whose dial is under way holds the lock; skip it.
            let Ok(mut slot) = host.conn.try_lock() else {
                continue;
            };
            if host.active.load(Ordering::SeqCst) > 0 {
                continue;
            }
            if let Some(conn) = slot.take() {
                info!(host = %id, "closing idle connection");
                conn.close(0u32.into(), b"idle");
            }
            drop(slot);
            let mut hosts = self.hosts.lock().expect("poisoned");
            if hosts.get(&id).is_some_and(|h| Arc::ptr_eq(h, &host))
                && host.active.load(Ordering::SeqCst) == 0
            {
                hosts.remove(&id);
            }
        }
    }

    /// How many hosts the pool holds an entry for.
    pub fn len(&self) -> usize {
        self.hosts.lock().expect("poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn host(&self, id: EndpointId) -> Arc<Host> {
        self.hosts
            .lock()
            .expect("poisoned")
            .entry(id)
            .or_insert_with(|| {
                Arc::new(Host {
                    conn: tokio::sync::Mutex::new(None),
                    active: AtomicUsize::new(0),
                    last_used: Mutex::new(Instant::now()),
                })
            })
            .clone()
    }

    /// The host's live connection, or a new one. The flag says whether it
    /// was dialed now.
    async fn connection(
        &self,
        host: &Host,
        id: EndpointId,
        relay: Option<&RelayUrl>,
    ) -> Result<(Connection, bool), OpenError> {
        let mut slot = host.conn.lock().await;
        if let Some(conn) = slot.as_ref().filter(|c| c.close_reason().is_none()) {
            return Ok((conn.clone(), false));
        }
        let addr = EndpointAddr::from_parts(id, relay.cloned().map(TransportAddr::Relay));
        let started = Instant::now();
        let conn = match tokio::time::timeout(
            self.options.dial_timeout,
            self.ep.connect(addr, ALPN),
        )
        .await
        {
            Err(_) => return Err(OpenError::DialTimeout),
            Ok(Err(e)) => return Err(OpenError::Dial(e.to_string())),
            Ok(Ok(conn)) => conn,
        };
        info!(
            host = %id,
            connect_ms = started.elapsed().as_millis() as u64,
            path = path_kind(&conn),
            "connected"
        );
        *slot = Some(conn.clone());
        Ok((conn, true))
    }

    async fn open_on(
        &self,
        conn: &Connection,
        target: &str,
    ) -> Result<(SendStream, RecvStream), OpenError> {
        let stream_error = |e: String| match conn.close_reason() {
            Some(reason) => OpenError::Stream(format!("connection closed: {reason}")),
            None => OpenError::Stream(e),
        };
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| stream_error(e.to_string()))?;
        stream_header::write_request(&mut send, target)
            .await
            .map_err(|e| stream_error(e.to_string()))?;
        let status = tokio::time::timeout(
            self.options.status_timeout,
            stream_header::read_status(&mut recv),
        )
        .await
        .map_err(|_| OpenError::Stream("no answer to the stream header".into()))?;
        match status.map_err(|e| stream_error(format!("{e:#}")))? {
            Status::Ok => Ok((send, recv)),
            Status::Refused(reason) => {
                warn!(target, %reason, "host refused the stream");
                Err(OpenError::Refused(reason))
            }
        }
    }
}

/// The kind of the connection's selected path.
pub fn path_kind(conn: &Connection) -> &'static str {
    match conn.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.remote_addr().is_ip() => "direct",
        Some(p) if p.remote_addr().is_relay() => "relay",
        Some(_) => "other",
        None => "none",
    }
}
