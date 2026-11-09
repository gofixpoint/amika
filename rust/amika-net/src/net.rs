//! Endpoint options shared by every role: which relays, relay-only mode,
//! address lookup, QUIC timeouts, and the UDP bind address.

use std::{net::SocketAddr, path::PathBuf, str::FromStr, time::Duration};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use iroh::{
    Endpoint, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher,
    endpoint::{Builder, QuicTransportConfig, presets},
};
use n0_future::StreamExt;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum RelayChoice {
    /// n0's free public relays.
    N0,
    /// n0 Pro project relays: `--relay-url` plus `--api-secret-file`.
    N0Pro,
    /// Self-hosted `iroh-relay` servers given with `--relay-url`.
    Custom,
    /// No relays. Peers must give direct addresses. For tests on one machine.
    None,
}

#[derive(Debug, Clone, Args)]
pub struct NetArgs {
    /// Which relays this endpoint uses.
    #[arg(long, value_enum, default_value_t = RelayChoice::N0)]
    pub relay: RelayChoice,
    /// Relay URLs for `n0-pro` and `custom`. Repeat for more than one.
    #[arg(long = "relay-url")]
    pub relay_urls: Vec<RelayUrl>,
    /// File that holds the n0 project API secret (for `n0-pro`).
    #[arg(long)]
    pub api_secret_file: Option<PathBuf>,
    /// File that holds a shared token for self-hosted relays (for `custom`).
    #[arg(long)]
    pub relay_token_file: Option<PathBuf>,
    /// Send every packet through the relay. No direct UDP paths.
    #[arg(long)]
    pub relay_only: bool,
    /// Turn off n0's address lookup. Callers must then give the host's relay URL.
    #[arg(long)]
    pub no_lookup: bool,
    /// QUIC idle timeout for the connection, in seconds.
    #[arg(long, default_value_t = 60)]
    pub idle_timeout_secs: u64,
    /// QUIC keep-alive interval, in seconds.
    #[arg(long, default_value_t = 5)]
    pub keepalive_secs: u64,
    /// Bind the IPv4 UDP socket here (host:port). On Fly.io, use
    /// `fly-global-services:0`.
    #[arg(long)]
    pub bind: Option<String>,
}

/// Builds an endpoint builder with the relay, lookup and QUIC options set.
/// The caller adds its ALPNs and hooks, then binds.
pub async fn builder(net: &NetArgs, secret: SecretKey) -> Result<Builder> {
    let mut b = match net.relay {
        RelayChoice::N0 => Endpoint::builder(presets::N0).secret_key(secret),
        RelayChoice::Custom => {
            let map = custom_relay_map(net)?;
            Endpoint::builder(presets::N0)
                .secret_key(secret)
                .relay_mode(RelayMode::Custom(map))
        }
        RelayChoice::N0Pro => Endpoint::builder(n0_pro_preset(net, secret)?),
        RelayChoice::None => Endpoint::builder(presets::N0)
            .secret_key(secret)
            .relay_mode(RelayMode::Disabled),
    };
    if net.no_lookup {
        b = b.clear_address_lookup();
    }
    if net.relay_only {
        b = b.clear_ip_transports();
    }
    if let Some(bind) = &net.bind {
        let addr = resolve_v4(bind).await?;
        b = b.bind_addr(addr)?;
    }
    Ok(b.transport_config(transport_config(net)?))
}

#[cfg_attr(not(unix), allow(dead_code))] // Only the agent uses these.
impl NetArgs {
    /// Renders the options as command-line arguments, with absolute paths.
    /// The agent is started with them, and they are part of the agent's
    /// config, so two equal option sets give equal argument lists.
    pub fn to_args(&self) -> Result<Vec<String>> {
        let relay = self
            .relay
            .to_possible_value()
            .context("relay choice has no name")?;
        let mut args = vec!["--relay".to_string(), relay.get_name().to_string()];
        for url in &self.relay_urls {
            args.extend(["--relay-url".to_string(), url.to_string()]);
        }
        for (flag, path) in [
            ("--api-secret-file", &self.api_secret_file),
            ("--relay-token-file", &self.relay_token_file),
        ] {
            if let Some(path) = path {
                args.extend([flag.to_string(), absolute(path)?]);
            }
        }
        if self.relay_only {
            args.push("--relay-only".into());
        }
        if self.no_lookup {
            args.push("--no-lookup".into());
        }
        args.extend([
            "--idle-timeout-secs".into(),
            self.idle_timeout_secs.to_string(),
            "--keepalive-secs".into(),
            self.keepalive_secs.to_string(),
        ]);
        if let Some(bind) = &self.bind {
            args.extend(["--bind".into(), bind.clone()]);
        }
        Ok(args)
    }
}

/// Returns `path` as an absolute path string. It does not touch the file.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn absolute(path: &std::path::Path) -> Result<String> {
    let abs =
        std::path::absolute(path).with_context(|| format!("making {} absolute", path.display()))?;
    abs.into_os_string()
        .into_string()
        .map_err(|p| anyhow::anyhow!("path {p:?} is not UTF-8"))
}

/// Waits up to `timeout` for a home relay, then logs the endpoint's id, home
/// relay and network report. Returns the home relay URL if there is one.
pub async fn report_online(ep: &Endpoint, timeout: Duration) -> Option<RelayUrl> {
    if tokio::time::timeout(timeout, ep.online()).await.is_err() {
        warn!("endpoint not online after {timeout:?}");
    }
    let relay = ep.addr().relay_urls().next().cloned();
    info!(id = %ep.id(), relay = ?relay.as_ref().map(|r| r.to_string()), "endpoint online");
    if let Some(report) = ep.net_report().get() {
        info!(
            udp_v4 = report.udp_v4,
            udp_v6 = report.udp_v6,
            mapping_varies_by_dest = ?report.mapping_varies_by_dest(),
            preferred_relay = ?report.preferred_relay.as_ref().map(|r| r.to_string()),
            captive_portal = ?report.captive_portal,
            "net report"
        );
    }
    relay
}

/// Logs each change of the home relay until the endpoint closes.
pub fn spawn_home_relay_logger(ep: &Endpoint) {
    let mut stream = ep.home_relay_status().stream();
    tokio::spawn(async move {
        while let Some(statuses) = stream.next().await {
            for s in statuses {
                info!(
                    relay = %s.url(),
                    connected = s.is_connected(),
                    last_error = ?s.last_error().map(|e| e.to_string()),
                    auth_denied = ?s.auth_denied_reason(),
                    "home relay status"
                );
            }
        }
    });
}

fn custom_relay_map(net: &NetArgs) -> Result<RelayMap> {
    if net.relay_urls.is_empty() {
        bail!("--relay custom needs at least one --relay-url");
    }
    let token = match &net.relay_token_file {
        Some(path) => Some(read_secret(path)?),
        None => None,
    };
    let configs = net.relay_urls.iter().map(|url| {
        // QUIC address discovery needs TLS, so a plain-HTTP relay gets none.
        let mut cfg = RelayConfig::from(url.clone());
        if url.scheme() == "http" {
            cfg.quic = None;
        }
        match &token {
            Some(t) => cfg.with_auth_token(t.clone()),
            None => cfg,
        }
    });
    Ok(RelayMap::from_iter(configs))
}

fn n0_pro_preset(net: &NetArgs, secret: SecretKey) -> Result<iroh_services::IrohServicesPreset> {
    let path = net
        .api_secret_file
        .as_ref()
        .context("--relay n0-pro needs --api-secret-file")?;
    let api_secret = read_secret(path)?;
    let mut preset = iroh_services::preset().secret_key(secret);
    if net.relay_urls.is_empty() {
        warn!("--relay n0-pro with no --relay-url uses n0's public relays with a project token");
    } else {
        preset = preset.relays(net.relay_urls.iter().map(|u| u.to_string()))?;
    }
    Ok(preset.api_secret_from_str(&api_secret)?.build()?)
}

fn transport_config(net: &NetArgs) -> Result<QuicTransportConfig> {
    let idle = Duration::from_secs(net.idle_timeout_secs)
        .try_into()
        .context("idle timeout is out of range")?;
    Ok(QuicTransportConfig::builder()
        .max_idle_timeout(Some(idle))
        .keep_alive_interval(Duration::from_secs(net.keepalive_secs))
        .build())
}

/// Reads a secret from a file. Never logs the value.
fn read_secret(path: &PathBuf) -> Result<String> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(text.trim().to_string())
}

async fn resolve_v4(addr: &str) -> Result<SocketAddr> {
    if let Ok(sa) = SocketAddr::from_str(addr) {
        return Ok(sa);
    }
    tokio::net::lookup_host(addr)
        .await
        .with_context(|| format!("resolving {addr}"))?
        .find(SocketAddr::is_ipv4)
        .with_context(|| format!("{addr} has no IPv4 address"))
}
