//! The connect role: the SSH `ProxyCommand`. Dials a host, opens one stream
//! to a target, and pipes stdin and stdout through it.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use clap::Args;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, RecvStream, SendStream},
};
use tokio::io::{self, AsyncWriteExt};
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
    /// Read the host's relay URL from this line (1-based) of this file,
    /// instead of `--host-relay`. Format: `<file>:<line>`.
    #[arg(long)]
    pub host_relay_from: Option<String>,
}

impl HostAddrArgs {
    /// The host's relay URL, from `--host-relay` or `--host-relay-from`.
    pub fn relay(&self) -> Result<Option<RelayUrl>> {
        if let Some(spec) = &self.host_relay_from {
            let (file, line) = spec
                .rsplit_once(':')
                .context("--host-relay-from needs <file>:<line>")?;
            let line: usize = line.parse().context("bad line in --host-relay-from")?;
            let urls = net::read_url_lines(&file.into(), &[line])?;
            return Ok(urls.into_iter().next());
        }
        Ok(self.host_relay.clone())
    }
}

#[derive(Debug, Clone, Args)]
pub struct ConnectArgs {
    /// This device's key file. Without it, the connect role uses a new key.
    #[arg(long)]
    pub key_file: Option<PathBuf>,
    #[command(flatten)]
    pub host: HostAddrArgs,
    /// The target on the host, for example `rig:<id>:22`.
    #[arg(long)]
    pub target: Target,
    #[command(flatten)]
    pub net: net::NetArgs,
}

pub async fn run(args: ConnectArgs) -> Result<()> {
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
    let (mut send, mut recv) = open_target(&conn, &args.target).await?;

    let mut stdin = io::stdin();
    let mut stdout = io::stdout();
    let to_host = async {
        let r = pipe::copy_flush(&mut stdin, &mut send).await;
        let _ = send.finish();
        r
    };
    let from_host = async {
        let r = pipe::copy_flush(&mut recv, &mut stdout).await;
        let _ = stdout.flush().await;
        r
    };
    // The session ends when the host side ends. Our stdin closing only
    // finishes our half; the host still sends its final bytes.
    tokio::pin!(to_host);
    tokio::select! {
        r = from_host => { r?; }
        r = &mut to_host => {
            r?;
            pipe::copy_flush(&mut recv, &mut stdout).await?;
        }
    }
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
    dial_id(ep, host, host.host_id).await
}

/// Dials `id`, with the relay and addresses in `host`.
pub async fn dial_id(ep: &Endpoint, host: &HostAddrArgs, id: EndpointId) -> Result<Connection> {
    let addrs = host
        .host_addr
        .iter()
        .copied()
        .map(TransportAddr::Ip)
        .chain(host.relay()?.into_iter().map(TransportAddr::Relay));
    let addr = EndpointAddr::from_parts(id, addrs);
    let started = std::time::Instant::now();
    let conn = tokio::time::timeout(DIAL_TIMEOUT, ep.connect(addr, ALPN))
        .await
        .context("dial timed out")?
        .context("dial failed")?;
    info!(
        host = %id,
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
