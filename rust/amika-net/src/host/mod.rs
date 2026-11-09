//! The host role: a sidecar that hostd starts and supervises.
//!
//! - It holds the host key, which hostd gives on a file descriptor.
//! - It stays on its home relay, and accepts connections on the ALPN
//!   `amika/net/1`. It reports its endpoint id and home relay to hostd.
//! - Check 1: for each new connection, it asks hostd whether the caller may
//!   connect (`check_peer`). It closes a refused connection before it
//!   accepts a stream.
//! - Check 2: for each stream, it reads the header and asks hostd for the
//!   target (`open`). hostd answers with a loopback address, or a refusal
//!   reason that goes back to the caller.
//! - It copies bytes both ways between the stream and the target.
//! - It closes a caller's connections when hostd sends `revoke`.
//!
//! It never decides on its own which callers, rigs or ports exist. See
//! [`control`] for the socket to hostd.

mod allowlist;
mod control;
mod registry;
#[cfg(test)]
mod tests;

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::Args;
use iroh::{
    Endpoint, EndpointId, RelayUrl, Watcher,
    endpoint::{Connection, RecvStream, SendStream},
};
use n0_future::StreamExt;
use tokio::{
    net::TcpStream,
    signal::unix::{SignalKind, signal},
};
use tracing::{info, warn};

use self::{allowlist::Allowlist, control::Control, registry::Registry};
use crate::{
    header::{self, ALPN, Refusal, Status, Target},
    keys,
    net::{self, EndpointArgs, Relays},
    paths, pipe,
};

/// QUIC close code for a caller that the rules refuse.
const CLOSE_NOT_ALLOWED: u32 = 403;
/// QUIC close code for a caller that the host cannot check now, because
/// hostd is not connected or did not answer.
const CLOSE_UNAVAILABLE: u32 = 503;
/// Stream reset code for a header that does not parse.
const RESET_BAD_HEADER: u32 = 400;
/// How long a caller may take to send the stream header.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the host may take to connect to a target.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Args)]
pub struct HostArgs {
    /// hostd's control socket.
    #[arg(long, required_unless_present = "test_allowlist")]
    pub control_socket: Option<PathBuf>,
    /// The file descriptor that holds the host key: 32 raw bytes. The host
    /// closes it after it reads the key.
    #[arg(
        long,
        required_unless_present = "key_file",
        conflicts_with = "key_file"
    )]
    pub key_fd: Option<i32>,
    /// The host key file: the 32-byte seed as base64, mode 0600. For tests.
    #[arg(long)]
    pub key_file: Option<PathBuf>,
    /// A relay URL for the host. Repeat for more than one. The host picks
    /// its home relay from them.
    #[arg(long = "relay-url")]
    pub relay_urls: Vec<RelayUrl>,
    /// A JSON allowlist file in place of hostd. For tests.
    #[arg(long, hide = true, conflicts_with = "control_socket")]
    pub test_allowlist: Option<PathBuf>,
    #[command(flatten)]
    pub net: EndpointArgs,
}

pub async fn run(args: HostArgs) -> Result<()> {
    let secret = match (args.key_fd, &args.key_file) {
        (Some(fd), _) => keys::read_fd(fd)?,
        (None, Some(path)) => keys::load(path)?,
        (None, None) => bail!("give --key-fd or --key-file"),
    };
    let choice = args.net.relay_choice(!args.relay_urls.is_empty());
    let relays = Arc::new(Relays::new(&args.net, choice, &secret)?);
    let ep = net::builder(&args.net, &relays, &args.relay_urls, secret)
        .await?
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;
    net::spawn_home_relay_logger(&ep);
    relays.spawn_refresh(ep.clone());
    info!(id = %ep.id(), sockets = ?ep.bound_sockets(), relay = ?choice, "host bound");
    let ep2 = ep.clone();
    tokio::spawn(async move { net::report_online(&ep2, Duration::from_secs(15)).await });

    let registry = Registry::new();
    let watch_parent = args.control_socket.is_some();
    let authority = match (&args.control_socket, &args.test_allowlist) {
        (Some(path), _) => {
            Authority::Hostd(Control::start(path.clone(), ep.clone(), registry.clone()))
        }
        (None, Some(path)) => {
            warn!("serving from a test allowlist, not from hostd");
            Authority::Allowlist(Arc::new(Allowlist::load(path)?))
        }
        (None, None) => bail!("give --control-socket"),
    };
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    tokio::select! {
        () = serve(ep.clone(), authority, registry.clone()) => {}
        _ = term.recv() => info!("SIGTERM; exiting"),
        _ = int.recv() => info!("SIGINT; exiting"),
        () = parent_exit(watch_parent) => warn!("the parent process exited; exiting"),
        () = stale_relay_token(&ep, &relays, &registry) => {
            ep.close().await;
            bail!("the home relay refused an old token; exiting so that hostd starts a new amika-net");
        }
    }
    ep.close().await;
    Ok(())
}

/// Who decides check 1 and check 2.
#[derive(Clone)]
enum Authority {
    Hostd(Arc<Control>),
    Allowlist(Arc<Allowlist>),
}

/// The answer to check 1.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PeerCheck {
    Allowed(Caller),
    Refused,
    /// The host cannot check now: hostd is not connected or did not answer.
    Unavailable(String),
}

/// What hostd says about an allowed caller. For logs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Caller {
    /// `device` or `service`.
    kind: String,
    /// The principal that owns a device, as `<kind>:<id>`.
    principal: Option<String>,
    /// The service name, for example `dialer`.
    service: Option<String>,
}

impl Caller {
    fn role(&self) -> String {
        match &self.service {
            Some(service) => format!("service:{service}"),
            None => self.kind.clone(),
        }
    }
}

impl Authority {
    async fn check_peer(&self, peer: EndpointId) -> PeerCheck {
        match self {
            Authority::Hostd(c) => c.check_peer(peer).await,
            Authority::Allowlist(a) => a.check_peer(peer),
        }
    }

    async fn open(&self, peer: EndpointId, target: &Target) -> Result<SocketAddr, Refusal> {
        match self {
            Authority::Hostd(c) => c.open(peer, target).await,
            Authority::Allowlist(a) => a.open(target),
        }
    }
}

/// Accepts connections until the endpoint closes.
async fn serve(ep: Endpoint, authority: Authority, registry: Arc<Registry>) {
    while let Some(incoming) = ep.accept().await {
        let authority = authority.clone();
        let registry = registry.clone();
        tokio::spawn(async move {
            match incoming.await {
                Ok(conn) => serve_connection(conn, authority, registry).await,
                Err(e) => info!(error = %e, "incoming connection failed"),
            }
        });
    }
}

/// Runs check 1, then serves the connection's streams until it closes.
async fn serve_connection(conn: Connection, authority: Authority, registry: Arc<Registry>) {
    let peer = conn.remote_id();
    let epoch = registry.epoch();
    let caller = match authority.check_peer(peer).await {
        PeerCheck::Allowed(caller) => caller,
        PeerCheck::Refused => {
            warn!(%peer, "caller not allowed; closing the connection");
            conn.close(CLOSE_NOT_ALLOWED.into(), b"caller not allowed");
            return;
        }
        PeerCheck::Unavailable(why) => {
            warn!(%peer, %why, "cannot check the caller; closing the connection");
            conn.close(CLOSE_UNAVAILABLE.into(), b"host not ready");
            return;
        }
    };
    // A revoke that came while check 1 ran also refuses this connection.
    let Some(_registered) = registry.register(&conn, epoch) else {
        warn!(%peer, "caller revoked during check 1; closing the connection");
        conn.close(registry::CLOSE_REVOKED.into(), b"access revoked");
        return;
    };
    let caller = Arc::new(caller);
    info!(
        %peer,
        role = %caller.role(),
        principal = ?caller.principal,
        selected = ?paths::selected(&conn),
        "connection accepted"
    );
    paths::spawn_logger(&conn, "host");
    loop {
        match conn.accept_bi().await {
            Ok((send, recv)) => {
                let stream = StreamCtx {
                    conn: conn.clone(),
                    caller: caller.clone(),
                    authority: authority.clone(),
                };
                tokio::spawn(stream.serve(send, recv));
            }
            Err(e) => {
                let stats = conn.stats();
                info!(
                    %peer,
                    reason = %e,
                    udp_rx = stats.udp_rx.bytes,
                    udp_tx = stats.udp_tx.bytes,
                    "connection closed"
                );
                return;
            }
        }
    }
}

struct StreamCtx {
    conn: Connection,
    caller: Arc<Caller>,
    authority: Authority,
}

impl StreamCtx {
    /// Reads the header, runs check 2, connects to the target and copies
    /// bytes both ways.
    async fn serve(self, mut send: SendStream, mut recv: RecvStream) {
        let peer = self.conn.remote_id();
        let role = self.caller.role();
        let target = match tokio::time::timeout(HEADER_TIMEOUT, header::read_request(&mut recv))
            .await
        {
            Ok(Ok(target)) => target,
            Ok(Err(e)) => {
                info!(%peer, %role, error = %format!("{e:#}"), "bad stream header; resetting the stream");
                reset(&mut send, &mut recv);
                return;
            }
            Err(_) => {
                info!(%peer, %role, "no stream header in time; resetting the stream");
                reset(&mut send, &mut recv);
                return;
            }
        };
        let started = Instant::now();
        let tcp = match self.connect(peer, &target).await {
            Ok(tcp) => tcp,
            Err(reason) => {
                info!(%peer, %role, %target, %reason, "stream refused");
                if let Err(e) = refuse(&mut send, reason).await {
                    info!(%peer, error = %format!("{e:#}"), "could not send the refusal");
                }
                return;
            }
        };
        if let Err(e) = header::write_status(&mut send, Status::Ok).await {
            info!(%peer, %role, %target, error = %format!("{e:#}"), "stream closed before ok");
            return;
        }
        let path = paths::selected(&self.conn).kind;
        info!(%peer, %role, %target, ?path, "stream opened");
        let spliced = pipe::splice(tcp, send, recv).await;
        info!(
            %peer,
            %role,
            %target,
            path = ?paths::selected(&self.conn).kind,
            bytes_to_target = spliced.to_local,
            bytes_to_caller = spliced.to_remote,
            duration_ms = paths::ms(started.elapsed()),
            close = spliced.error.as_deref().unwrap_or("finished"),
            "stream finished"
        );
    }

    /// Check 2, then the TCP connection to the target. Only a loopback
    /// address is a valid target.
    async fn connect(&self, peer: EndpointId, target: &Target) -> Result<TcpStream, Refusal> {
        let addr = self.authority.open(peer, target).await?;
        if !addr.ip().is_loopback() {
            warn!(%target, %addr, "the target address is not a loopback address");
            return Err(Refusal::Unreachable);
        }
        let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(e)) => {
                info!(%target, %addr, error = %e, "target unreachable");
                return Err(Refusal::Unreachable);
            }
            Err(_) => {
                info!(%target, %addr, "target connect timed out");
                return Err(Refusal::Unreachable);
            }
        };
        let _ = tcp.set_nodelay(true);
        Ok(tcp)
    }
}

async fn refuse(send: &mut SendStream, reason: Refusal) -> Result<()> {
    header::write_status(send, Status::Refused(reason)).await?;
    send.finish().context("finishing the stream")?;
    Ok(())
}

fn reset(send: &mut SendStream, recv: &mut RecvStream) {
    let _ = send.reset(RESET_BAD_HEADER.into());
    let _ = recv.stop(RESET_BAD_HEADER.into());
}

/// Returns when the home relay refuses this endpoint's token after a token
/// refresh, and no connection is open.
///
/// iroh 1.4.1 keeps the token that a relay connection started with for all
/// its reconnects, and the home relay connection never ends. So a home relay
/// connection that drops after the first token expires cannot come back.
/// Direct paths keep working, so the host waits for its open connections to
/// end, then exits, and hostd starts it again with a new token.
async fn stale_relay_token(ep: &Endpoint, relays: &Relays, registry: &Registry) {
    let mut statuses = ep.home_relay_status().stream();
    loop {
        let Some(statuses) = statuses.next().await else {
            return std::future::pending().await;
        };
        let denied = statuses.iter().any(|s| s.auth_denied_reason().is_some());
        if denied && relays.refreshes() > 0 {
            break;
        }
    }
    warn!("the home relay refused the token; exiting when the open connections end");
    while registry.open() > 0 {
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Returns when the parent process exits. hostd starts a new `amika-net`
/// when it starts again, and two processes with one key collide at the
/// relay. Never returns if `watch` is false, or if init started this
/// process.
async fn parent_exit(watch: bool) {
    // SAFETY: getppid has no preconditions and cannot fail.
    let parent = unsafe { libc::getppid() };
    if !watch || parent == 1 {
        return std::future::pending().await;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        // SAFETY: as above.
        if unsafe { libc::getppid() } != parent {
            return;
        }
    }
}
