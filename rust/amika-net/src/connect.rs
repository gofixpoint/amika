//! The connect role: the SSH `ProxyCommand`. Opens one stream to a target on
//! a host, and pipes stdin and stdout through it.
//!
//! With a key file, the stream goes through the per-user agent (see
//! [`crate::agent`]), which holds the device key. `--direct`, or no key
//! file, dials from this process with its own endpoint.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use clap::Args;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, RecvStream, SendStream},
};
use tracing::info;

use crate::{
    header::{self, ALPN, Status, Target},
    keys, net, paths, pipe,
};

/// How long a dial may take before the connect role gives up.
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);

/// Where a host is: its endpoint id, and optionally its relay and addresses.
#[derive(Debug, Clone, Args)]
pub struct HostAddrArgs {
    /// The host's endpoint id.
    #[arg(long)]
    pub host_id: EndpointId,
    /// The host's home relay URL. Needed when address lookup is off.
    #[arg(long)]
    pub host_relay: Option<RelayUrl>,
    /// Direct addresses of the host (ip:port). Optional.
    #[arg(long)]
    pub host_addr: Vec<SocketAddr>,
}

#[derive(Debug, Clone, Args)]
pub struct ConnectArgs {
    /// This device's key file. With it, connect goes through the agent.
    /// Without it, connect dials directly with a new key.
    #[arg(long)]
    pub key_file: Option<PathBuf>,
    /// Dial from this process, without the agent. Two direct connects with
    /// the same key collide at the relay, so use this only for tests.
    #[arg(long)]
    pub direct: bool,
    #[cfg(unix)]
    #[command(flatten)]
    pub agent: crate::agent::client::AgentOpts,
    #[command(flatten)]
    pub host: HostAddrArgs,
    /// The target on the host, for example `rig:<id>:22`.
    #[arg(long)]
    pub target: Target,
    #[command(flatten)]
    pub net: net::NetArgs,
}

pub async fn run(args: ConnectArgs) -> Result<()> {
    #[cfg(unix)]
    if let (Some(key_file), false) = (&args.key_file, args.direct) {
        return crate::agent::client::connect(
            &args.agent,
            key_file,
            &args.net,
            &args.host,
            &args.target,
        )
        .await;
    }
    run_direct(args).await
}

async fn run_direct(args: ConnectArgs) -> Result<()> {
    let secret = device_key(args.key_file.as_deref())?;
    let ep = net::builder(&args.net, secret).await?.bind().await?;
    net::spawn_home_relay_logger(&ep);
    let result = session(&ep, &args).await;
    ep.close().await;
    result
}

async fn session(ep: &Endpoint, args: &ConnectArgs) -> Result<()> {
    let conn = dial(ep, &args.host).await?;
    paths::spawn_logger(&conn, "connect");
    let (send, recv) = open_target(&conn, &args.target).await?;
    pipe::stdio(send, recv).await?;
    let stats = conn.stats();
    info!(
        udp_rx = stats.udp_rx.bytes,
        udp_tx = stats.udp_tx.bytes,
        "session finished"
    );
    conn.close(0u32.into(), b"done");
    Ok(())
}

/// Returns the device key from `path`, or a new key if there is no path.
pub fn device_key(path: Option<&std::path::Path>) -> Result<SecretKey> {
    match path {
        Some(p) => keys::load_or_create(p),
        None => Ok(SecretKey::generate()),
    }
}

/// Dials the host and logs the first selected path.
pub async fn dial(ep: &Endpoint, host: &HostAddrArgs) -> Result<Connection> {
    let addrs = host
        .host_addr
        .iter()
        .copied()
        .map(TransportAddr::Ip)
        .chain(host.host_relay.iter().cloned().map(TransportAddr::Relay));
    let addr = EndpointAddr::from_parts(host.host_id, addrs);
    let started = std::time::Instant::now();
    let conn = tokio::time::timeout(DIAL_TIMEOUT, ep.connect(addr, ALPN))
        .await
        .context("dial timed out")?
        .context("dial failed")?;
    info!(
        host = %host.host_id,
        connect_ms = paths::ms(started.elapsed()),
        selected = ?paths::selected(&conn),
        "connected"
    );
    Ok(conn)
}

/// Opens a stream, sends the header, and waits for `ok`.
pub async fn open_target(conn: &Connection, target: &Target) -> Result<(SendStream, RecvStream)> {
    let (mut send, mut recv) = conn.open_bi().await.context("opening stream")?;
    header::write_request(&mut send, target).await?;
    // A host that rejected us at the handshake closes the connection here.
    match header::read_status(&mut recv).await {
        Ok(Status::Ok) => Ok((send, recv)),
        Ok(Status::Refused { reason, detail }) => {
            bail!("host refused {target}: {reason:?} {detail}")
        }
        Err(e) => match conn.close_reason() {
            Some(reason) => bail!("host closed the connection: {reason}"),
            None => Err(e),
        },
    }
}
