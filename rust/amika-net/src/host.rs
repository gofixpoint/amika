//! The host role: keeps the endpoint on its relay, rejects callers that are
//! not on the allowlist right after the handshake, and for each stream reads
//! the header, connects to the mapped TCP address and copies bytes.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};

use anyhow::{Context, Result};
use clap::Args;
use iroh::{
    EndpointId,
    endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks, RecvStream, SendStream, Side},
};
use serde::Deserialize;
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::{
    header::{self, ALPN, Refusal, Status, Target},
    keys, net, paths, pipe,
};

/// QUIC close code for a caller that is not on the allowlist.
const CLOSE_NOT_ALLOWED: u32 = 403;

#[derive(Debug, Clone, Args)]
pub struct HostArgs {
    /// The host's endpoint key file (made with mode 600 if missing).
    #[arg(long)]
    pub key_file: PathBuf,
    /// The host config file (TOML): allowed callers and rig targets.
    #[arg(long)]
    pub config: PathBuf,
    #[command(flatten)]
    pub net: net::NetArgs,
}

/// The host config file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostConfig {
    /// Endpoint ids that may connect. The stub for the signed org rules.
    #[serde(default)]
    pub allowed_callers: Vec<EndpointId>,
    /// Accept any caller. For probes only.
    #[serde(default)]
    pub allow_any_caller: bool,
    /// Serve the spike-only `echo` target.
    #[serde(default)]
    pub echo: bool,
    /// Address of hostd's HTTP listener, for the `hostd` target.
    pub hostd: Option<SocketAddr>,
    /// Rig id to (port to TCP address). TOML keys are strings, so ports are too.
    #[serde(default)]
    pub rigs: HashMap<String, HashMap<String, SocketAddr>>,
}

pub async fn run(args: HostArgs) -> Result<()> {
    let config = Arc::new(load_config(&args.config)?);
    let secret = keys::load_or_create(&args.key_file)?;
    let gate = AccessGate::new(args.config.clone(), &config);
    let ep = net::builder(&args.net, secret)
        .await?
        .alpns(vec![ALPN.to_vec()])
        .hooks(gate)
        .bind()
        .await?;
    net::spawn_home_relay_logger(&ep);
    // Accept at once; a host with no relay never goes online.
    let ep2 = ep.clone();
    tokio::spawn(async move { net::report_online(&ep2, Duration::from_secs(15)).await });

    while let Some(incoming) = ep.accept().await {
        let config = config.clone();
        tokio::spawn(async move {
            match incoming.await {
                Ok(conn) => serve_connection(conn, config).await,
                Err(e) => info!(error = %e, "incoming connection failed"),
            }
        });
    }
    Ok(())
}

fn load_config(path: &Path) -> Result<HostConfig> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

/// Check 1 of the design: the caller's endpoint id must be allowed. It runs
/// after the TLS handshake proves the id, before any stream is accepted.
///
/// The gate reads the allowlist from the config file at each handshake, so a
/// change applies to new connections without a restart (as new signed rules
/// would). If the file does not parse, the last good allowlist stays.
#[derive(Debug)]
struct AccessGate {
    path: PathBuf,
    last_good: RwLock<(HashSet<EndpointId>, bool)>,
}

impl AccessGate {
    fn new(path: PathBuf, config: &HostConfig) -> Self {
        Self {
            path,
            last_good: RwLock::new(Self::allowlist(config)),
        }
    }

    fn allowlist(config: &HostConfig) -> (HashSet<EndpointId>, bool) {
        (
            config.allowed_callers.iter().copied().collect(),
            config.allow_any_caller,
        )
    }

    fn allows(&self, caller: &EndpointId) -> bool {
        match load_config(&self.path) {
            Ok(config) => *self.last_good.write().expect("poisoned") = Self::allowlist(&config),
            Err(e) => {
                warn!(error = %format!("{e:#}"), "config reload failed; keeping the last allowlist")
            }
        }
        let (allowed, allow_any) = &*self.last_good.read().expect("poisoned");
        *allow_any || allowed.contains(caller)
    }
}

impl EndpointHooks for AccessGate {
    async fn after_handshake(&self, conn: &Connection) -> AfterHandshakeOutcome {
        if conn.side() == Side::Client || self.allows(&conn.remote_id()) {
            return AfterHandshakeOutcome::Accept;
        }
        warn!(caller = %conn.remote_id(), "caller not allowed; closing connection");
        AfterHandshakeOutcome::Reject {
            error_code: CLOSE_NOT_ALLOWED.into(),
            reason: b"caller not allowed".to_vec(),
        }
    }
}

async fn serve_connection(conn: Connection, config: Arc<HostConfig>) {
    let caller = conn.remote_id();
    info!(%caller, selected = ?paths::selected(&conn), "connection accepted");
    paths::spawn_logger(&conn, "host");
    loop {
        match conn.accept_bi().await {
            Ok((send, recv)) => {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve_stream(send, recv, &config).await {
                        info!(%caller, error = %e, "stream ended with error");
                    }
                });
            }
            Err(e) => {
                let stats = conn.stats();
                info!(%caller, reason = %e, udp_rx = stats.udp_rx.bytes, udp_tx = stats.udp_tx.bytes, "connection closed");
                return;
            }
        }
    }
}

async fn serve_stream(
    mut send: SendStream,
    mut recv: RecvStream,
    config: &HostConfig,
) -> Result<()> {
    let target = match header::read_request(&mut recv).await {
        Ok(t) => t,
        Err(e) => {
            let status = Status::Refused {
                reason: Refusal::BadHeader,
                detail: e.to_string(),
            };
            header::write_status(&mut send, &status).await?;
            send.finish()?;
            return Err(e);
        }
    };
    info!(%target, "stream opened");
    if target == Target::Echo && config.echo {
        header::write_status(&mut send, &Status::Ok).await?;
        let n = pipe::copy_flush(&mut recv, &mut send).await?;
        send.finish()?;
        info!(%target, bytes = n, "echo stream finished");
        return Ok(());
    }
    let addr = match resolve(config, &target) {
        Ok(addr) => addr,
        Err((reason, detail)) => {
            info!(%target, ?reason, "stream refused");
            header::write_status(&mut send, &Status::Refused { reason, detail }).await?;
            send.finish()?;
            return Ok(());
        }
    };
    let tcp = match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(addr)).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => return refuse_unreachable(&mut send, &target, e.to_string()).await,
        Err(_) => return refuse_unreachable(&mut send, &target, "connect timed out".into()).await,
    };
    tcp.set_nodelay(true)?;
    header::write_status(&mut send, &Status::Ok).await?;
    let (up, down) = pipe::splice(tcp, send, recv).await;
    info!(%target, bytes_up = up, bytes_down = down, "stream finished");
    Ok(())
}

async fn refuse_unreachable(send: &mut SendStream, target: &Target, detail: String) -> Result<()> {
    info!(%target, %detail, "target unreachable");
    header::write_status(
        send,
        &Status::Refused {
            reason: Refusal::Unreachable,
            detail,
        },
    )
    .await?;
    send.finish()?;
    Ok(())
}

/// Check 2 of the design, as a stub: the config, not signed rules, says
/// which targets exist.
fn resolve(config: &HostConfig, target: &Target) -> Result<SocketAddr, (Refusal, String)> {
    match target {
        Target::Hostd => config
            .hostd
            .ok_or((Refusal::NotAllowed, "no hostd target on this host".into())),
        Target::Echo => Err((Refusal::NotAllowed, "echo is off".into())),
        Target::Rig { id, port } => {
            let ports = config
                .rigs
                .get(id)
                .ok_or_else(|| (Refusal::UnknownRig, format!("no rig {id}")))?;
            ports
                .get(&port.to_string())
                .copied()
                .ok_or_else(|| (Refusal::PortNotAllowed, format!("port {port} on rig {id}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> HostConfig {
        toml::from_str(
            r#"
            allowed_callers = []
            [rigs.r1]
            22 = "127.0.0.1:2222"
            "#,
        )
        .unwrap()
    }

    #[test]
    fn resolve_maps_known_targets_and_refuses_others() {
        let c = config();
        let rig = |id: &str, port| Target::Rig {
            id: id.into(),
            port,
        };
        assert_eq!(
            resolve(&c, &rig("r1", 22)).unwrap(),
            "127.0.0.1:2222".parse().unwrap()
        );
        assert_eq!(
            resolve(&c, &rig("r1", 80)).unwrap_err().0,
            Refusal::PortNotAllowed
        );
        assert_eq!(
            resolve(&c, &rig("r2", 22)).unwrap_err().0,
            Refusal::UnknownRig
        );
        assert_eq!(
            resolve(&c, &Target::Hostd).unwrap_err().0,
            Refusal::NotAllowed
        );
        assert_eq!(
            resolve(&c, &Target::Echo).unwrap_err().0,
            Refusal::NotAllowed
        );
    }
}
