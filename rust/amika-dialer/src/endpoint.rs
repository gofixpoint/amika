//! The dialer's iroh endpoint: its key, its relays, its QUIC timeouts and
//! its UDP socket.
//!
//! The dialer only dials out, so it accepts no connections and registers
//! no ALPN. Address lookup is off: the reverse proxy names each host's
//! endpoint id and home relay, as the control plane gave them.

use std::{net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Context, Result};
use iroh::{
    Endpoint, RelayConfig as IrohRelayConfig, RelayMap, RelayMode as IrohRelayMode, SecretKey,
    Watcher,
    endpoint::{Builder, QuicTransportConfig, presets},
};
use tracing::{info, warn};

use crate::config::{Config, RelayConfig, RelayMode};

/// Binds the endpoint that `config` describes.
pub async fn bind(config: &Config) -> Result<Endpoint> {
    let mut b = builder(&config.relay, config.secret_key.clone())?
        .clear_address_lookup()
        .transport_config(transport_config(config)?);
    if let Some(bind) = &config.udp_bind {
        b = b.bind_addr(resolve_v4(bind).await?)?;
    }
    b.bind().await.context("binding the iroh endpoint")
}

/// Waits up to `timeout` for a home relay, then logs the endpoint id, the
/// home relay and whether UDP works. UDP is what gives direct paths.
pub async fn report_online(ep: &Endpoint, timeout: Duration) {
    if tokio::time::timeout(timeout, ep.online()).await.is_err() {
        warn!("endpoint not online after {timeout:?}");
    }
    let relay = ep.addr().relay_urls().next().map(|r| r.to_string());
    info!(endpoint_id = %ep.id(), relay = ?relay, "endpoint online");
    match ep.net_report().get() {
        Some(report) => info!(
            udp_v4 = report.udp_v4,
            udp_v6 = report.udp_v6,
            mapping_varies_by_dest = ?report.mapping_varies_by_dest(),
            "net report"
        ),
        None => warn!("no net report yet"),
    }
}

fn builder(relay: &RelayConfig, secret: SecretKey) -> Result<Builder> {
    Ok(match relay.mode {
        RelayMode::N0Pro => Endpoint::builder(n0_pro_preset(relay, secret)?),
        RelayMode::Custom => Endpoint::builder(presets::N0)
            .secret_key(secret)
            .relay_mode(IrohRelayMode::Custom(custom_relay_map(relay))),
        RelayMode::N0 => Endpoint::builder(presets::N0).secret_key(secret),
        RelayMode::None => Endpoint::builder(presets::N0)
            .secret_key(secret)
            .relay_mode(IrohRelayMode::Disabled),
    })
}

fn n0_pro_preset(
    relay: &RelayConfig,
    secret: SecretKey,
) -> Result<iroh_services::IrohServicesPreset> {
    let api_secret = relay
        .n0_api_secret
        .as_deref()
        .context("n0-pro needs an API secret")?;
    Ok(iroh_services::preset()
        .secret_key(secret)
        .relays(relay.urls.iter().map(|u| u.to_string()))?
        .api_secret_from_str(api_secret)?
        .build()?)
}

fn custom_relay_map(relay: &RelayConfig) -> RelayMap {
    RelayMap::from_iter(relay.urls.iter().map(|url| {
        // QUIC address discovery needs TLS, so a plain-HTTP relay gets none.
        let mut cfg = IrohRelayConfig::from(url.clone());
        if url.scheme() == "http" {
            cfg.quic = None;
        }
        match &relay.token {
            Some(t) => cfg.with_auth_token(t.clone()),
            None => cfg,
        }
    }))
}

fn transport_config(config: &Config) -> Result<QuicTransportConfig> {
    let idle = config
        .quic_idle_timeout
        .try_into()
        .context("QUIC idle timeout is out of range")?;
    Ok(QuicTransportConfig::builder()
        .max_idle_timeout(Some(idle))
        .keep_alive_interval(config.quic_keepalive)
        .build())
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
