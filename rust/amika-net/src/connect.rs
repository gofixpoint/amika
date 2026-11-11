//! The connect role: the SSH `ProxyCommand`. Opens one stream to a target on
//! a host, and pipes stdin and stdout through it.
//!
//! On Unix the stream goes through the per-user agent (see
//! [`crate::agent`]), which holds the device key. On Windows, and with the
//! test flag `--direct`, this process dials with its own endpoint.
//!
//! A caller dials a host by its endpoint id and home relay URL only. Both
//! come from Amika's control plane.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use clap::Args;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, TransportAddr,
    endpoint::{Connection, RecvStream, SendStream},
};
use tracing::info;

use crate::{
    header::{self, ALPN, Status, Target},
    keys,
    net::{self, EndpointArgs, RelayChoice, Relays},
    paths, pipe,
};

/// How long a dial may take before the connect role gives up.
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);

/// Where a host is.
#[derive(Debug, Clone, Args)]
pub struct HostAddrArgs {
    /// The host's endpoint id.
    #[arg(long)]
    pub endpoint: EndpointId,
    /// The host's home relay URL.
    #[arg(long)]
    pub relay_url: Option<RelayUrl>,
    /// A direct address of the host (ip:port). Repeat for more than one.
    #[arg(long = "direct-addr")]
    pub direct_addrs: Vec<SocketAddr>,
}

#[derive(Debug, Clone, Args)]
pub struct ConnectArgs {
    /// This device's key file: the 32-byte seed as base64, mode 0600.
    #[arg(long)]
    pub key_file: PathBuf,
    /// Dial from this process, without the agent. Two processes with one
    /// key collide at the relay. For tests.
    #[arg(long, hide = true)]
    pub direct: bool,
    #[cfg(unix)]
    #[command(flatten)]
    pub agent: crate::agent::client::AgentOpts,
    #[command(flatten)]
    pub host: HostAddrArgs,
    /// The target on the host: `hostd` or `rig:<rig id>:<port>`.
    #[arg(long)]
    pub target: Target,
    #[command(flatten)]
    pub net: EndpointArgs,
}

impl ConnectArgs {
    /// The relay choice. With no `--relay`, a caller uses the host's relay.
    pub fn relay_choice(&self) -> RelayChoice {
        self.net.relay_choice(self.host.relay_url.is_some())
    }
}

pub async fn run(args: ConnectArgs) -> Result<()> {
    #[cfg(unix)]
    if !args.direct {
        return crate::agent::client::connect(&args).await;
    }
    run_direct(args).await
}

async fn run_direct(args: ConnectArgs) -> Result<()> {
    let secret = keys::load(&args.key_file)?;
    let relays = Relays::new(&args.net, args.relay_choice(), &secret)?;
    let ep = net::builder(&args.net, &relays, &[], secret)
        .await?
        .bind()
        .await?;
    net::spawn_home_relay_logger(&ep);
    let result = async {
        let conn = dial(&ep, &relays, &args.host).await?;
        paths::spawn_logger(&conn, "connect");
        let (send, recv) = open_target(&conn, &args.target).await?;
        pipe::stdio(send, recv).await?;
        conn.close(0u32.into(), b"done");
        anyhow::Ok(())
    }
    .await;
    ep.close().await;
    result
}

/// Dials the host by its endpoint id, relay URL and direct addresses, and
/// logs the first selected path.
pub async fn dial(ep: &Endpoint, relays: &Relays, host: &HostAddrArgs) -> Result<Connection> {
    if let Some(url) = &host.relay_url {
        relays.ensure(ep, url).await;
    }
    let addrs = host
        .direct_addrs
        .iter()
        .copied()
        .map(TransportAddr::Ip)
        .chain(host.relay_url.iter().cloned().map(TransportAddr::Relay));
    let addr = EndpointAddr::from_parts(host.endpoint, addrs);
    let started = std::time::Instant::now();
    let conn = tokio::time::timeout(DIAL_TIMEOUT, ep.connect(addr, ALPN))
        .await
        .context("dial timed out")?
        .context("dial failed")?;
    info!(
        host = %host.endpoint,
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
    // A host that refuses the caller closes the connection here.
    match header::read_status(&mut recv).await {
        Ok(Status::Ok) => Ok((send, recv)),
        Ok(Status::Refused(reason)) => bail!("host refused {target}: {reason}"),
        Err(e) => match conn.close_reason() {
            Some(reason) => bail!("host closed the connection: {reason}"),
            None => Err(e),
        },
    }
}
