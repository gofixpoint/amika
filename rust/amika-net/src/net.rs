//! Endpoint options shared by every role: which relays and how to sign in
//! to them, QUIC timeouts, and the UDP bind address.
//!
//! Address lookup is always off. A caller learns a host's endpoint id and
//! relay URL from Amika's control plane, not from n0's lookup service.

use std::{
    collections::HashSet,
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use iroh::{
    Endpoint, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher,
    endpoint::{Builder, QuicTransportConfig, presets},
};
use n0_future::StreamExt;
use tracing::{info, warn};

/// How long an n0 Pro relay token is valid. iroh-services uses the same.
const N0_TOKEN_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum RelayChoice {
    /// n0's free public relays. For development only.
    N0,
    /// n0 Pro relays, with a token from the n0 project API secret
    /// (`--api-secret-file`). With no relay URL, n0's public relay list.
    N0Pro,
    /// The relay URLs given, with an optional shared token
    /// (`--relay-token-file`).
    Custom,
    /// No relays. Peers need direct addresses. For tests on one machine.
    None,
}

#[derive(Debug, Clone, Args)]
pub struct EndpointArgs {
    /// Which relays to use, and how to sign in to them. Default: `custom`
    /// when a relay URL is given, else `n0`.
    #[arg(long, value_enum, env = "AMIKA_NET_RELAY")]
    pub relay: Option<RelayChoice>,
    /// The file that holds the n0 project API secret (for `n0-pro`).
    #[arg(long, env = "AMIKA_NET_API_SECRET_FILE")]
    pub api_secret_file: Option<PathBuf>,
    /// The file that holds a shared token for the relays (for `custom`).
    #[arg(long, env = "AMIKA_NET_RELAY_TOKEN_FILE")]
    pub relay_token_file: Option<PathBuf>,
    /// Send every packet through the relay, with no direct paths. For tests.
    #[arg(long, hide = true)]
    pub relay_only: bool,
    /// QUIC idle timeout, in seconds.
    #[arg(long, default_value_t = 60)]
    pub idle_timeout_secs: u64,
    /// QUIC keep-alive interval, in seconds.
    #[arg(long, default_value_t = 5)]
    pub keepalive_secs: u64,
    /// Bind the IPv4 UDP socket here (host:port).
    #[arg(long)]
    pub bind: Option<String>,
}

impl Default for EndpointArgs {
    /// The command-line defaults: no relay choice, a 60 s idle timeout and
    /// a 5 s keep-alive.
    fn default() -> Self {
        Self {
            relay: None,
            api_secret_file: None,
            relay_token_file: None,
            relay_only: false,
            idle_timeout_secs: 60,
            keepalive_secs: 5,
            bind: None,
        }
    }
}

impl EndpointArgs {
    /// The relay choice: the one given, else the default for whether relay
    /// URLs are given.
    pub fn relay_choice(&self, have_urls: bool) -> RelayChoice {
        self.relay.unwrap_or(if have_urls {
            RelayChoice::Custom
        } else {
            RelayChoice::N0
        })
    }

    /// Renders the options as command-line arguments, with the relay choice
    /// stated and absolute paths. The agent starts with them, and they are
    /// part of its config, so equal options give equal argument lists.
    pub fn to_args(&self, relay: RelayChoice) -> Result<Vec<String>> {
        let name = relay
            .to_possible_value()
            .context("relay choice has no name")?;
        let mut args = vec!["--relay".to_string(), name.get_name().to_string()];
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

/// How this endpoint signs in to relays. A caller adds a host's relay to
/// its relay map when it dials, so it signs in to that relay the same way.
#[derive(Debug)]
pub struct Relays {
    choice: RelayChoice,
    token: Option<String>,
    known: Mutex<HashSet<RelayUrl>>,
}

impl Relays {
    pub fn new(args: &EndpointArgs, choice: RelayChoice, secret: &SecretKey) -> Result<Self> {
        let token = match choice {
            RelayChoice::N0Pro => {
                let path = args
                    .api_secret_file
                    .as_deref()
                    .context("--relay n0-pro needs --api-secret-file")?;
                Some(n0_pro_token(&read_secret(path)?, secret)?)
            }
            RelayChoice::Custom => match &args.relay_token_file {
                Some(path) => Some(read_secret(path)?),
                None => None,
            },
            RelayChoice::N0 | RelayChoice::None => None,
        };
        Ok(Self {
            choice,
            token,
            known: Mutex::default(),
        })
    }

    /// The relay mode to bind with, from this endpoint's own relay URLs.
    fn mode(&self, urls: &[RelayUrl]) -> Result<RelayMode> {
        let n0_map = || iroh::endpoint::default_relay_mode().relay_map();
        let map = match self.choice {
            RelayChoice::None => {
                if !urls.is_empty() {
                    bail!("--relay none takes no --relay-url");
                }
                return Ok(RelayMode::Disabled);
            }
            RelayChoice::N0 => {
                if !urls.is_empty() {
                    bail!("--relay n0 takes no --relay-url; use --relay custom");
                }
                n0_map()
            }
            RelayChoice::N0Pro if urls.is_empty() => {
                n0_map().with_auth_token(self.token.clone().context("n0 Pro has no token")?)
            }
            RelayChoice::N0Pro | RelayChoice::Custom => {
                RelayMap::from_iter(urls.iter().map(|u| self.config(u.clone())))
            }
        };
        self.known
            .lock()
            .expect("poisoned")
            .extend(map.urls::<Vec<_>>());
        Ok(RelayMode::Custom(map))
    }

    /// Adds `url` to the endpoint's relay map, with this endpoint's token,
    /// unless the map has it. iroh can send through any relay, but it signs
    /// in only to relays in its map.
    pub async fn ensure(&self, ep: &Endpoint, url: &RelayUrl) {
        if self.choice == RelayChoice::None {
            return;
        }
        if !self.known.lock().expect("poisoned").insert(url.clone()) {
            return;
        }
        info!(relay = %url, "adding the host's relay");
        ep.insert_relay(url.clone(), Arc::new(self.config(url.clone())))
            .await;
    }

    fn config(&self, url: RelayUrl) -> RelayConfig {
        // QUIC address discovery needs TLS, so a plain-HTTP relay gets none.
        let plain = url.scheme() == "http";
        let mut cfg = RelayConfig::from(url);
        if plain {
            cfg.quic = None;
        }
        match &self.token {
            Some(t) => cfg.with_auth_token(t.clone()),
            None => cfg,
        }
    }
}

/// Makes an endpoint builder with the relay and QUIC options set, and
/// address lookup off. The caller adds its ALPNs, then binds.
pub async fn builder(
    args: &EndpointArgs,
    relays: &Relays,
    urls: &[RelayUrl],
    secret: SecretKey,
) -> Result<Builder> {
    let mut b = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .relay_mode(relays.mode(urls)?)
        .clear_address_lookup();
    if args.relay_only {
        b = b.clear_ip_transports();
    }
    if let Some(bind) = &args.bind {
        b = b.bind_addr(resolve_v4(bind).await?)?;
    }
    Ok(b.transport_config(transport_config(args)?))
}

/// Returns `path` as an absolute path string. It does not touch the file.
pub fn absolute(path: &Path) -> Result<String> {
    let abs =
        std::path::absolute(path).with_context(|| format!("making {} absolute", path.display()))?;
    abs.into_os_string()
        .into_string()
        .map_err(|p| anyhow::anyhow!("path {p:?} is not UTF-8"))
}

/// Waits up to `timeout` for a home relay, then logs the endpoint's id,
/// home relay and network report.
pub async fn report_online(ep: &Endpoint, timeout: Duration) {
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
}

/// Logs each change of the home relay status until the endpoint closes.
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

/// The relay token that iroh-services makes from an n0 project API secret:
/// a capability to use the relays, issued to this endpoint.
fn n0_pro_token(api_secret: &str, secret: &SecretKey) -> Result<String> {
    let api = iroh_services::api_secret::ApiSecret::from_str(api_secret)
        .map_err(|e| anyhow::anyhow!("the n0 API secret does not parse: {e}"))?;
    let token = iroh_services::caps::create_api_token_from_secret_key(
        api.secret,
        secret.public(),
        N0_TOKEN_TTL,
        iroh_services::caps::Caps::relay_use(),
    );
    Ok(data_encoding::BASE32_NOPAD
        .encode(&token.encode())
        .to_ascii_lowercase())
}

fn transport_config(args: &EndpointArgs) -> Result<QuicTransportConfig> {
    let idle = Duration::from_secs(args.idle_timeout_secs)
        .try_into()
        .context("idle timeout is out of range")?;
    Ok(QuicTransportConfig::builder()
        .max_idle_timeout(Some(idle))
        .keep_alive_interval(Duration::from_secs(args.keepalive_secs))
        .build())
}

/// Reads a secret from a file. Never logs the value.
fn read_secret(path: &Path) -> Result<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(relay: Option<RelayChoice>) -> EndpointArgs {
        EndpointArgs {
            relay,
            ..EndpointArgs::default()
        }
    }

    #[test]
    fn relay_urls_default_to_custom_relays() {
        assert_eq!(args(None).relay_choice(true), RelayChoice::Custom);
        assert_eq!(args(None).relay_choice(false), RelayChoice::N0);
        let pro = args(Some(RelayChoice::N0Pro));
        assert_eq!(pro.relay_choice(true), RelayChoice::N0Pro);
    }

    #[test]
    fn n0_pro_needs_an_api_secret() {
        let secret = SecretKey::generate();
        assert!(Relays::new(&args(None), RelayChoice::N0Pro, &secret).is_err());
    }

    #[test]
    fn custom_relays_carry_the_token_and_plain_http_has_no_quic() {
        let relays = Relays {
            choice: RelayChoice::Custom,
            token: Some("t".into()),
            known: Mutex::default(),
        };
        let cfg = relays.config("http://127.0.0.1:3340".parse().unwrap());
        assert_eq!(cfg.auth_token.as_deref(), Some("t"));
        assert!(cfg.quic.is_none());
        let cfg = relays.config("https://relay.example".parse().unwrap());
        assert!(cfg.quic.is_some());

        let RelayMode::Custom(map) = relays
            .mode(&["https://relay.example".parse().unwrap()])
            .unwrap()
        else {
            panic!("expected a custom relay map");
        };
        assert_eq!(map.len(), 1);
        assert!(
            relays
                .known
                .lock()
                .unwrap()
                .contains(&"https://relay.example".parse().unwrap())
        );
    }

    #[test]
    fn n0_and_none_take_no_relay_urls() {
        let url: RelayUrl = "https://relay.example".parse().unwrap();
        for choice in [RelayChoice::N0, RelayChoice::None] {
            let relays = Relays::new(&args(None), choice, &SecretKey::generate()).unwrap();
            assert!(relays.mode(std::slice::from_ref(&url)).is_err());
            assert!(relays.mode(&[]).is_ok());
        }
    }
}
