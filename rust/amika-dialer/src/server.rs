//! The HTTP side: one request from the reverse proxy in, one stream to the
//! host's `hostd` target out.
//!
//! For each request the dialer checks the assertion, opens a stream on the
//! host's connection, and speaks HTTP/1.1 to hostd over it. The response
//! streams back as it arrives. A WebSocket upgrade is sent to hostd as
//! it came; after hostd's `101` the dialer copies bytes both ways until
//! either side ends.
//!
//! hostd checks each request with its own credentials, as it does for a
//! request from the gateway. The dialer adds no check of its own past the
//! assertion.

use std::{
    convert::Infallible,
    future::Future,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use bytes::Bytes;
use http::{Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, server::conn::http1, service::service_fn, upgrade::OnUpgrade};
use hyper_util::rt::TokioIo;
use iroh::RelayUrl;
use tokio::net::TcpListener;
use tracing::{debug, info, warn};

use crate::{
    forward::{self, ForwardRequestParsed, HOST_ID_HEADER, Secrets},
    pool::{OpenError, Pool, TargetStream},
    stream_header::HOSTD_TARGET,
};

pub type Body = BoxBody<Bytes, hyper::Error>;

/// The path the platform's health check asks. Answered only for a request
/// that carries no assertion and names no host: a rig serves its own
/// `/healthz`.
pub const HEALTH_PATH: &str = "/healthz";

pub struct Dialer {
    pub pool: Arc<Pool>,
    pub secrets: Secrets,
    /// When not empty, a host's relay must be one of these.
    pub relay_urls: Vec<RelayUrl>,
    pub response_timeout: Duration,
    /// Open WebSockets, so shutdown can wait for them.
    upgrades: AtomicUsize,
}

impl Dialer {
    pub fn new(
        pool: Arc<Pool>,
        secrets: Secrets,
        relay_urls: Vec<RelayUrl>,
        response_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            secrets,
            relay_urls,
            response_timeout,
            upgrades: AtomicUsize::new(0),
        })
    }
}

/// Serves `listener` until `shutdown` resolves, then stops accepting and
/// waits up to `grace` for open requests and WebSockets.
pub async fn serve(
    listener: TcpListener,
    dialer: Arc<Dialer>,
    shutdown: impl Future<Output = ()>,
    grace: Duration,
) -> Result<()> {
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let connections = Arc::new(AtomicUsize::new(0));
    tokio::pin!(shutdown);
    loop {
        let (tcp, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(a) => a,
                Err(e) => {
                    warn!(error = %e, "accept failed");
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        let _ = tcp.set_nodelay(true);
        let dialer = dialer.clone();
        let service = service_fn(move |req| {
            let dialer = dialer.clone();
            async move { Ok::<_, Infallible>(handle(dialer, req, peer).await) }
        });
        let mut stop = stop_rx.clone();
        let connections = connections.clone();
        connections.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let conn = http1::Builder::new()
                .serve_connection(TokioIo::new(tcp), service)
                .with_upgrades();
            tokio::pin!(conn);
            let result = tokio::select! {
                r = conn.as_mut() => r,
                _ = async { let _ = stop.wait_for(|stop| *stop).await; } => {
                    // Finish the request in flight, then close.
                    conn.as_mut().graceful_shutdown();
                    conn.await
                }
            };
            connections.fetch_sub(1, Ordering::SeqCst);
            if let Err(e) = result {
                debug!(error = %e, "connection ended with an error");
            }
        });
    }
    info!("shutting down: no new connections");
    let _ = stop_tx.send(true);
    let deadline = Instant::now() + grace;
    let open = || connections.load(Ordering::SeqCst) + dialer.upgrades.load(Ordering::SeqCst);
    while open() > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if open() > 0 {
        warn!(
            connections = connections.load(Ordering::SeqCst),
            websockets = dialer.upgrades.load(Ordering::SeqCst),
            "closing what is still open at the end of the grace"
        );
    }
    Ok(())
}

/// Answers one request. Never fails: every fault is a status.
pub async fn handle(
    dialer: Arc<Dialer>,
    req: Request<Incoming>,
    peer: SocketAddr,
) -> Response<Body> {
    if req.uri().path() == HEALTH_PATH
        && !forward::has_assertion(req.headers())
        && !req.headers().contains_key(HOST_ID_HEADER)
    {
        return plain(StatusCode::OK, "ok");
    }
    let started = Instant::now();
    let (mut parts, body) = req.into_parts();
    let checked = match forward::read_forward_request(&parts, &dialer.secrets, now_ms()) {
        Ok(c) => c,
        Err(refusal) => {
            warn!(
                %peer,
                method = %parts.method,
                path = parts.uri.path(),
                status = refusal.status,
                reason = %refusal.reason,
                "refused"
            );
            let status = StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::BAD_REQUEST);
            return plain(status, status.canonical_reason().unwrap_or("Error"));
        }
    };
    // The proxy signed the relay, and the endpoint holds tokens only for
    // its own relays. The relay is dialed as configured, so iroh uses that
    // relay's token.
    let relay = match &checked.relay_url {
        None => None,
        Some(named) => match pick_relay(&dialer.relay_urls, named) {
            Some(r) => Some(r),
            None => {
                warn!(host = %checked.host_id, relay = %named, "relay is not one of DIALER_RELAY_URLS");
                return plain(StatusCode::BAD_GATEWAY, "Bad Gateway");
            }
        },
    };
    let on_upgrade = checked
        .upgrade
        .then(|| parts.extensions.remove::<OnUpgrade>())
        .flatten();
    let response = exchange(&dialer, &checked, relay.as_ref(), body, on_upgrade).await;
    let status = match &response {
        Ok(r) => r.status().as_u16(),
        Err((status, _)) => status.as_u16(),
    };
    info!(
        host = %checked.host_id,
        org = %checked.org_id,
        method = %checked.method,
        status,
        upgrade = checked.upgrade,
        ms = started.elapsed().as_millis() as u64,
        "forwarded"
    );
    match response {
        Ok(r) => r,
        Err((status, reason)) => {
            warn!(host = %checked.host_id, %reason, "forward failed");
            plain(status, status.canonical_reason().unwrap_or("Error"))
        }
    }
}

type Failure = (StatusCode, String);

/// Sends the checked request to hostd over a new stream, and returns its
/// response.
async fn exchange(
    dialer: &Arc<Dialer>,
    checked: &ForwardRequestParsed,
    relay: Option<&RelayUrl>,
    body: Incoming,
    on_upgrade: Option<OnUpgrade>,
) -> Result<Response<Body>, Failure> {
    let TargetStream {
        send,
        recv,
        lease,
        path,
    } = dialer
        .pool
        .open(checked.endpoint_id, relay, HOSTD_TARGET)
        .await
        .map_err(|e| {
            let status = match e {
                OpenError::DialTimeout => StatusCode::GATEWAY_TIMEOUT,
                _ => StatusCode::BAD_GATEWAY,
            };
            (status, e.to_string())
        })?;
    debug!(host = %checked.host_id, path, "stream open");
    let io = TokioIo::new(tokio::io::join(recv, send));
    let (mut sender, conn) = hyper::client::conn::http1::handshake::<_, Incoming>(io)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("handshake: {e}")))?;
    // The lease lives as long as the stream: through the response body,
    // and through the WebSocket after an upgrade.
    let lease = Arc::new(lease);
    let conn_lease = lease.clone();
    tokio::spawn(async move {
        let _lease = conn_lease;
        if let Err(e) = conn.with_upgrades().await {
            debug!(error = %e, "hostd connection ended with an error");
        }
    });

    let mut out = Request::builder()
        .method(checked.method.clone())
        .uri(checked.target.as_str())
        .body(body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("request: {e}")))?;
    *out.headers_mut() = checked.headers.clone();
    let mut response = tokio::time::timeout(dialer.response_timeout, sender.send_request(out))
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "hostd did not answer in time".into(),
            )
        })?
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("hostd: {e}")))?;
    drop(sender);

    let switching = response.status() == StatusCode::SWITCHING_PROTOCOLS;
    if switching {
        let Some(downstream) = on_upgrade else {
            return Err((
                StatusCode::BAD_GATEWAY,
                "hostd switched protocols unasked".into(),
            ));
        };
        let upstream = hyper::upgrade::on(&mut response);
        spawn_splice(dialer.clone(), downstream, upstream, lease, checked);
    }
    let headers = forward::relayable_response_headers(response.headers(), switching);
    let (mut parts, body) = response.into_parts();
    parts.headers = headers;
    Ok(Response::from_parts(parts, body.boxed()))
}

/// Copies bytes both ways between the caller's and hostd's upgraded
/// connections, until either side ends.
fn spawn_splice(
    dialer: Arc<Dialer>,
    downstream: OnUpgrade,
    upstream: OnUpgrade,
    lease: Arc<crate::pool::Lease>,
    checked: &ForwardRequestParsed,
) {
    let host = checked.host_id.clone();
    dialer.upgrades.fetch_add(1, Ordering::SeqCst);
    tokio::spawn(async move {
        let _lease = lease;
        let started = Instant::now();
        let result = async {
            let (down, up) = tokio::try_join!(downstream, upstream)?;
            let (mut down, mut up) = (TokioIo::new(down), TokioIo::new(up));
            Ok::<_, anyhow::Error>(tokio::io::copy_bidirectional(&mut down, &mut up).await?)
        }
        .await;
        dialer.upgrades.fetch_sub(1, Ordering::SeqCst);
        let secs = started.elapsed().as_secs();
        match result {
            Ok((to_host, to_caller)) => {
                info!(%host, to_host, to_caller, secs, "websocket closed")
            }
            Err(e) => info!(%host, error = %e, secs, "websocket ended with an error"),
        }
    });
}

/// The relay to dial for a host whose home relay is `named`: `named` when
/// the list is empty, else the configured relay it names, else `None`.
/// iroh writes a relay's host name with a trailing dot, and a configured
/// URL may not have one, so the dot does not count.
fn pick_relay(list: &[RelayUrl], named: &RelayUrl) -> Option<RelayUrl> {
    if list.is_empty() {
        return Some(named.clone());
    }
    let key = |u: &RelayUrl| {
        (
            u.scheme().to_string(),
            u.host_str()
                .map(|h| h.trim_end_matches('.').to_ascii_lowercase()),
            u.port_or_known_default(),
            u.path().trim_end_matches('/').to_string(),
        )
    };
    list.iter()
        .find(|allowed| key(allowed) == key(named))
        .cloned()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A refusal: the status and nothing else. The reason goes to the log.
fn plain(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(
        Full::new(Bytes::from(format!("{text}\n")))
            .map_err(|never| match never {})
            .boxed(),
    );
    *r.status_mut() = status;
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    #[test]
    fn a_relay_matches_with_or_without_the_trailing_dot() {
        let url = |s: &str| RelayUrl::from_str(s).unwrap();
        let configured = url("https://relay.example");
        let list = [configured.clone()];
        assert_eq!(
            pick_relay(&list, &url("https://relay.example./")),
            Some(configured.clone())
        );
        assert_eq!(
            pick_relay(&list, &url("https://RELAY.example/")),
            Some(configured)
        );
        assert_eq!(pick_relay(&list, &url("https://other.example./")), None);
        assert_eq!(pick_relay(&list, &url("http://relay.example./")), None);
        assert_eq!(pick_relay(&list, &url("https://relay.example:8443/")), None);
        let any = url("https://any.example./");
        assert_eq!(pick_relay(&[], &any), Some(any));
    }
}
