//! The dialer end to end on one machine: a caller signs a request as the
//! reverse proxy does, the dialer dials a fake host over iroh, and the
//! fake host passes the stream to a local HTTP server that stands in for
//! hostd.
//!
//! The fake host speaks the host's side of the stream header as the
//! contracts fix it, and runs check 1 (an allowlist of callers) and a
//! stand-in for check 2 (only the `hostd` target). No relay: the dialer
//! learns the host's loopback address from an in-memory address lookup.

use std::{
    convert::Infallible,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use amika_dialer::{
    forward::{
        AUTHORITY_HEADER, DIALER_LABEL, ENDPOINT_ID_HEADER, HOST_ID_HEADER, ORG_ID_HEADER,
        PROXY_ASSERTION_HEADER, RIG_HEADER, SERVICE_HEADER, Secrets, dialer_subject,
    },
    pool::{Pool, PoolOptions},
    server::{self, Dialer},
    token,
};
use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::{body::Frame, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use iroh::{
    Endpoint, EndpointId, RelayMode, SecretKey, address_lookup::memory::MemoryLookup,
    endpoint::presets,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

const PROXY_SECRET: &str = "proxy-secret-for-tests";
const AUTHORITY: &str = "web--my-rig.r.acme.o.amika.run";

#[tokio::test]
async fn a_get_reaches_hostd_with_the_gateway_headers() {
    let bed = Bed::start(HostRules::default()).await;
    let (status, headers, body) = bed
        .request(
            "GET",
            "/echo?x=1",
            &[
                ("cookie", "session=abc"),
                ("x-forwarded-for", "203.0.113.9"),
                ("x-amika-other", "forged"),
            ],
            Vec::new(),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(headers["x-hostd"], "fake");
    assert!(body.contains("GET /echo?x=1\n"), "{body}");
    assert!(body.contains(&format!("host: {AUTHORITY}\n")), "{body}");
    assert!(body.contains("x-amika-rig: my-rig\n"), "{body}");
    assert!(!body.contains("forged"), "{body}");
    assert!(body.contains("x-amika-service: web\n"), "{body}");
    assert!(body.contains("cookie: session=abc\n"), "{body}");
    assert!(!body.contains("x-forwarded-for"), "{body}");
    assert!(!body.contains("x-amika-proxy-token"), "{body}");
}

#[tokio::test]
async fn requests_share_one_connection_per_host() {
    let bed = Bed::start(HostRules::default()).await;
    for _ in 0..3 {
        let (status, _, _) = bed.request("GET", "/echo", &[], Vec::new()).await;
        assert_eq!(status, 200);
    }
    assert_eq!(bed.host.connections.load(Ordering::SeqCst), 1);
    assert_eq!(bed.host.streams.load(Ordering::SeqCst), 3);
    assert_eq!(bed.pool.len(), 1);
}

#[tokio::test]
async fn a_streamed_body_arrives_whole() {
    let bed = Bed::start(HostRules::default()).await;
    let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let (status, _, body) = bed.request("POST", "/upload", &[], payload.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        format!("got {} bytes, sum {}", payload.len(), sum(&payload))
    );
}

#[tokio::test]
async fn a_websocket_upgrade_carries_bytes_both_ways() {
    let bed = Bed::start(HostRules::default()).await;
    let mut tcp = TcpStream::connect(bed.addr).await.unwrap();
    let mut head = String::from("GET /ws HTTP/1.1\r\nhost: dialer.test\r\n");
    for (k, v) in bed.signed_headers() {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(
        "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n\
         sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    tcp.write_all(head.as_bytes()).await.unwrap();
    let mut reader = BufReader::new(tcp);
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        if line == "\r\n" {
            break;
        }
        lines.push(line.trim_end().to_ascii_lowercase());
    }
    assert!(lines[0].starts_with("http/1.1 101"), "{lines:?}");
    assert!(
        lines.contains(&"upgrade: websocket".to_string()),
        "{lines:?}"
    );
    // hostd saw the caller's key, which it needs for its accept header.
    assert!(
        lines.contains(&"x-seen-key: dghlihnhbxbszsbub25jzq==".to_string()),
        "{lines:?}"
    );
    for round in 0..3 {
        let msg = format!("hello {round}");
        reader.get_mut().write_all(msg.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; msg.len()];
        tokio::time::timeout(Duration::from_secs(5), reader.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(buf, msg.to_uppercase().as_bytes());
    }
}

#[tokio::test]
async fn bad_and_expired_assertions_never_reach_the_host() {
    let bed = Bed::start(HostRules::default()).await;
    let mut headers = bed.signed_headers();
    for (k, v) in headers.iter_mut() {
        if k == PROXY_ASSERTION_HEADER {
            v.replace_range(v.len() - 4.., "AAAA");
        }
    }
    assert_eq!(bed.raw_request("GET", "/echo", &headers).await, 401);

    let subject = bed.subject();
    let expired = token::sign(DIALER_LABEL, PROXY_SECRET, &subject, now_ms() - 1);
    let mut headers = bed.signed_headers();
    headers.retain(|(k, _)| k != PROXY_ASSERTION_HEADER);
    headers.push((PROXY_ASSERTION_HEADER.into(), expired));
    assert_eq!(bed.raw_request("GET", "/echo", &headers).await, 401);

    let wrong_key = token::sign(DIALER_LABEL, "not-the-secret", &subject, now_ms() + 10_000);
    let mut headers = bed.signed_headers();
    headers.retain(|(k, _)| k != PROXY_ASSERTION_HEADER);
    headers.push((PROXY_ASSERTION_HEADER.into(), wrong_key));
    assert_eq!(bed.raw_request("GET", "/echo", &headers).await, 401);

    let mut headers = bed.signed_headers();
    headers.retain(|(k, _)| k != PROXY_ASSERTION_HEADER);
    assert_eq!(bed.raw_request("GET", "/echo", &headers).await, 401);

    assert_eq!(bed.host.connections.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_host_refusal_is_a_502() {
    // Check 2 refuses the target.
    let bed = Bed::start(HostRules {
        refuse_streams: true,
        ..Default::default()
    })
    .await;
    let (status, _, _) = bed.request("GET", "/echo", &[], Vec::new()).await;
    assert_eq!(status, 502);

    // Check 1 refuses the dialer.
    let bed = Bed::start(HostRules {
        refuse_callers: true,
        ..Default::default()
    })
    .await;
    let (status, _, _) = bed.request("GET", "/echo", &[], Vec::new()).await;
    assert_eq!(status, 502);
}

#[tokio::test]
async fn an_unknown_host_is_a_bad_gateway() {
    let bed = Bed::start(HostRules::default()).await;
    let stranger = SecretKey::from_bytes(&[9u8; 32]).public();
    let headers = bed.signed_headers_for(&stranger.to_string());
    let status = bed.raw_request("GET", "/echo", &headers).await;
    assert!(status == 502 || status == 504, "{status}");

    // The host's endpoint under an assertion signed for the stranger.
    let mut headers = bed.signed_headers_for(&stranger.to_string());
    headers.retain(|(k, _)| k != ENDPOINT_ID_HEADER);
    headers.push((ENDPOINT_ID_HEADER.into(), bed.host.id.to_string()));
    assert_eq!(bed.raw_request("GET", "/echo", &headers).await, 401);
    assert_eq!(bed.host.connections.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_health_path_answers_without_an_assertion() {
    let bed = Bed::start(HostRules::default()).await;
    assert_eq!(bed.raw_request("GET", "/healthz", &[]).await, 200);
    // With an assertion it is a rig's path, and goes to the host.
    let (status, _, body) = bed.request("GET", "/healthz", &[], Vec::new()).await;
    assert_eq!(status, 200);
    assert!(body.contains("GET /healthz\n"), "{body}");
}

#[tokio::test]
async fn an_idle_connection_is_closed() {
    let bed = Bed::start_with(
        HostRules::default(),
        PoolOptions {
            idle: Duration::from_millis(1),
            ..Default::default()
        },
    )
    .await;
    let (status, _, _) = bed.request("GET", "/echo", &[], Vec::new()).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(20)).await;
    bed.pool.reap_once().await;
    assert!(bed.pool.is_empty());
    // A new request dials again.
    let (status, _, _) = bed.request("GET", "/echo", &[], Vec::new()).await;
    assert_eq!(status, 200);
    assert_eq!(bed.host.connections.load(Ordering::SeqCst), 2);
}

// The test bed.

#[derive(Default, Clone, Copy)]
struct HostRules {
    refuse_callers: bool,
    refuse_streams: bool,
}

struct FakeHost {
    id: EndpointId,
    connections: AtomicUsize,
    streams: AtomicUsize,
}

struct Bed {
    addr: SocketAddr,
    host: Arc<FakeHost>,
    pool: Arc<Pool>,
    _endpoints: (Endpoint, Endpoint),
}

impl Bed {
    async fn start(rules: HostRules) -> Self {
        Self::start_with(rules, PoolOptions::default()).await
    }

    async fn start_with(rules: HostRules, options: PoolOptions) -> Self {
        let hostd = start_fake_hostd().await;
        let dialer_key = SecretKey::generate();
        let dialer_id = dialer_key.public();
        let host_ep = Endpoint::builder(presets::N0)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Disabled)
            .clear_address_lookup()
            .alpns(vec![b"amika/net/1".to_vec()])
            .bind_addr("127.0.0.1:0".parse::<SocketAddr>().unwrap())
            .unwrap()
            .bind()
            .await
            .unwrap();
        let host = Arc::new(FakeHost {
            id: host_ep.id(),
            connections: AtomicUsize::new(0),
            streams: AtomicUsize::new(0),
        });
        tokio::spawn(run_fake_host(
            host_ep.clone(),
            host.clone(),
            rules,
            dialer_id,
            hostd,
        ));

        let lookup = MemoryLookup::new();
        let mut host_addr = host_ep.addr();
        host_addr.addrs.retain(|a| a.is_ip());
        lookup.add_endpoint_info(host_addr);
        let dialer_ep = Endpoint::builder(presets::N0)
            .secret_key(dialer_key)
            .relay_mode(RelayMode::Disabled)
            .clear_address_lookup()
            .address_lookup(lookup)
            .bind_addr("127.0.0.1:0".parse::<SocketAddr>().unwrap())
            .unwrap()
            .bind()
            .await
            .unwrap();
        let pool = Pool::new(
            dialer_ep.clone(),
            PoolOptions {
                dial_timeout: Duration::from_secs(5),
                ..options
            },
        );
        let dialer = Dialer::new(
            pool.clone(),
            Secrets {
                proxy: PROXY_SECRET.into(),
            },
            Vec::new(),
            Duration::from_secs(10),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(server::serve(
            listener,
            dialer,
            std::future::pending(),
            Duration::from_secs(1),
        ));
        Bed {
            addr,
            host,
            pool,
            _endpoints: (host_ep, dialer_ep),
        }
    }

    fn subject(&self) -> String {
        self.subject_for(&self.host.id.to_string())
    }

    /// The dialer hop's subject for a host at `endpoint`, with no relay.
    fn subject_for(&self, endpoint: &str) -> String {
        dialer_subject([
            "host_01", "org_01", "my-rig", "web", AUTHORITY, endpoint, "",
        ])
    }

    /// The headers the reverse proxy sends, with a fresh assertion.
    fn signed_headers(&self) -> Vec<(String, String)> {
        self.signed_headers_for(&self.host.id.to_string())
    }

    /// The headers for a host at `endpoint`, signed for it.
    fn signed_headers_for(&self, endpoint: &str) -> Vec<(String, String)> {
        let assertion = token::sign(
            DIALER_LABEL,
            PROXY_SECRET,
            &self.subject_for(endpoint),
            now_ms() + 10_000,
        );
        [
            (HOST_ID_HEADER, "host_01".to_string()),
            (ORG_ID_HEADER, "org_01".to_string()),
            (RIG_HEADER, "my-rig".to_string()),
            (SERVICE_HEADER, "web".to_string()),
            (AUTHORITY_HEADER, AUTHORITY.to_string()),
            (PROXY_ASSERTION_HEADER, assertion),
            (ENDPOINT_ID_HEADER, endpoint.to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
    }

    /// A signed request with a streamed body. Returns status, headers, body.
    async fn request(
        &self,
        method: &str,
        path: &str,
        extra: &[(&str, &str)],
        body: Vec<u8>,
    ) -> (u16, http::HeaderMap, String) {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "dialer.test");
        for (k, v) in self.signed_headers() {
            b = b.header(k, v);
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        // In chunks of unknown total length, as a browser upload arrives.
        let chunks: Vec<Result<Frame<Bytes>, Infallible>> = body
            .chunks(64 * 1024)
            .map(|c| Ok(Frame::data(Bytes::copy_from_slice(c))))
            .collect();
        let req = b
            .body(StreamBody::new(n0_future::stream::iter(chunks)))
            .unwrap();
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp))
            .await
            .unwrap();
        tokio::spawn(conn);
        let resp = tokio::time::timeout(Duration::from_secs(20), sender.send_request(req))
            .await
            .expect("dialer answered in time")
            .unwrap();
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    async fn raw_request(&self, method: &str, path: &str, headers: &[(String, String)]) -> u16 {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "dialer.test");
        for (k, v) in headers {
            b = b.header(k, v);
        }
        let req = b.body(Full::new(Bytes::new())).unwrap();
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp))
            .await
            .unwrap();
        tokio::spawn(conn);
        tokio::time::timeout(Duration::from_secs(20), sender.send_request(req))
            .await
            .expect("dialer answered in time")
            .unwrap()
            .status()
            .as_u16()
    }
}

/// The host's side of `amika-net`, as far as the dialer reaches it.
async fn run_fake_host(
    ep: Endpoint,
    host: Arc<FakeHost>,
    rules: HostRules,
    dialer_id: EndpointId,
    hostd: SocketAddr,
) {
    while let Some(incoming) = ep.accept().await {
        let host = host.clone();
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            // Check 1: the caller must be in the rules.
            if rules.refuse_callers || conn.remote_id() != dialer_id {
                conn.close(403u32.into(), b"caller not allowed");
                return;
            }
            host.connections.fetch_add(1, Ordering::SeqCst);
            while let Ok((mut send, recv)) = conn.accept_bi().await {
                host.streams.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut recv = BufReader::new(recv);
                    let mut lines = Vec::new();
                    loop {
                        let mut line = String::new();
                        recv.read_line(&mut line).await.unwrap();
                        if line == "\n" {
                            break;
                        }
                        lines.push(line.trim_end().to_string());
                    }
                    assert_eq!(lines, ["version 1", "target hostd"]);
                    // Check 2, as a stand-in: hostd is the only target.
                    if rules.refuse_streams {
                        send.write_all(b"refused not_allowed\n").await.unwrap();
                        let _ = send.finish();
                        return;
                    }
                    send.write_all(b"ok\n").await.unwrap();
                    let tcp = TcpStream::connect(hostd).await.unwrap();
                    let (mut tcp_r, mut tcp_w) = tcp.into_split();
                    let up = async {
                        let _ = tokio::io::copy_buf(&mut recv, &mut tcp_w).await;
                        let _ = tcp_w.shutdown().await;
                    };
                    let down = async {
                        let _ = tokio::io::copy(&mut tcp_r, &mut send).await;
                        let _ = send.finish();
                    };
                    tokio::join!(up, down);
                });
            }
        });
    }
}

/// A stand-in for hostd's HTTP listener.
async fn start_fake_hostd() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(tcp), service_fn(hostd_route))
                    .with_upgrades()
                    .await;
            });
        }
    });
    addr
}

type HostdBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

async fn hostd_route(
    mut req: Request<hyper::body::Incoming>,
) -> Result<Response<HostdBody>, Infallible> {
    let full = |s: String| Full::new(Bytes::from(s)).map_err(|n| match n {}).boxed();
    match req.uri().path() {
        "/upload" => {
            let body = req.into_body().collect().await.unwrap().to_bytes();
            Ok(Response::new(full(format!(
                "got {} bytes, sum {}",
                body.len(),
                sum(&body)
            ))))
        }
        "/ws" => {
            let key = req
                .headers()
                .get("sec-websocket-key")
                .map(|v| v.to_str().unwrap().to_string())
                .unwrap_or_default();
            let on = hyper::upgrade::on(&mut req);
            tokio::spawn(async move {
                let up = on.await.unwrap();
                let mut io = TokioIo::new(up);
                let mut buf = [0u8; 1024];
                loop {
                    let n = io.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    let upper = buf[..n].to_ascii_uppercase();
                    if io.write_all(&upper).await.is_err() {
                        return;
                    }
                }
            });
            let mut r = Response::new(full(String::new()));
            *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
            r.headers_mut()
                .insert("connection", "upgrade".parse().unwrap());
            r.headers_mut()
                .insert("upgrade", "websocket".parse().unwrap());
            r.headers_mut().insert("x-seen-key", key.parse().unwrap());
            Ok(r)
        }
        _ => {
            let mut text = format!("{} {}\n", req.method(), req.uri().path_and_query().unwrap());
            let mut names: Vec<_> = req.headers().keys().map(|k| k.as_str()).collect();
            names.sort();
            for name in names {
                for v in req.headers().get_all(name) {
                    text.push_str(&format!("{name}: {}\n", v.to_str().unwrap()));
                }
            }
            let mut r = Response::new(full(text));
            r.headers_mut().insert("x-hostd", "fake".parse().unwrap());
            r.headers_mut()
                .insert("connection", "keep-alive".parse().unwrap());
            Ok(r)
        }
    }
}

fn sum(bytes: &[u8]) -> u64 {
    bytes.iter().map(|&b| b as u64).sum()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
