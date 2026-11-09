//! The dialer's configuration, read once from the environment at start.
//!
//! Every fault is collected and reported together, so a deploy that is
//! missing three values is told about three.

use std::{net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Result, bail};
use iroh::{RelayUrl, SecretKey};

use crate::forward::Secrets;

/// Which relays the dialer's endpoint uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayMode {
    /// n0 Pro project relays: `DIALER_RELAY_URLS` and `DIALER_N0_API_SECRET`.
    N0Pro,
    /// Self-hosted `iroh-relay` servers in `DIALER_RELAY_URLS`, with an
    /// optional shared token.
    Custom,
    /// n0's free public relays. For tests only.
    N0,
    /// No relays. For tests on one machine only.
    None,
}

impl FromStr for RelayMode {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "n0-pro" => RelayMode::N0Pro,
            "custom" => RelayMode::Custom,
            "n0" => RelayMode::N0,
            "none" => RelayMode::None,
            _ => bail!("must be n0-pro, custom, n0 or none"),
        })
    }
}

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub mode: RelayMode,
    /// The relays the endpoint holds tokens for. When the list is not
    /// empty, a host's relay URL must be in it.
    pub urls: Vec<RelayUrl>,
    /// The n0 project API secret, for `n0-pro`.
    pub n0_api_secret: Option<String>,
    /// The shared token for `custom` relays.
    pub token: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    /// The dialer's endpoint key. Its public key is the `dialer` service
    /// in each org's rules.
    pub secret_key: SecretKey,
    pub secrets: Secrets,
    pub listen: SocketAddr,
    pub relay: RelayConfig,
    /// Where the endpoint binds its IPv4 UDP socket. On Fly.io,
    /// `fly-global-services:0`.
    pub udp_bind: Option<String>,
    pub quic_idle_timeout: Duration,
    pub quic_keepalive: Duration,
    /// The bound on a host's response head.
    pub response_timeout: Duration,
    /// How long shutdown waits for open requests and WebSockets.
    pub shutdown_grace: Duration,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the secrets.
        f.debug_struct("Config")
            .field("endpoint_id", &self.secret_key.public().to_string())
            .field("listen", &self.listen)
            .field("relay_mode", &self.relay.mode)
            .field("relay_urls", &self.relay.urls)
            .field("udp_bind", &self.udp_bind)
            .finish_non_exhaustive()
    }
}

impl Config {
    /// Reads the configuration from `env`, or fails naming every fault.
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let mut r = Reader {
            env: &env,
            faults: Vec::new(),
        };
        let secret_key = r.secret_key("DIALER_SECRET_KEY");
        let proxy = r.required("DIALER_PROXY_SECRET");
        let listen = r.parsed("DIALER_LISTEN", "0.0.0.0:8080");
        let mode = r.parsed("DIALER_RELAY", "n0-pro");
        let urls = r.relay_urls("DIALER_RELAY_URLS");
        let n0_api_secret = r.optional("DIALER_N0_API_SECRET");
        let token = r.optional("DIALER_RELAY_TOKEN");
        match mode {
            Some(RelayMode::N0Pro) if urls.is_empty() || n0_api_secret.is_none() => {
                r.fault("DIALER_RELAY=n0-pro needs DIALER_RELAY_URLS and DIALER_N0_API_SECRET")
            }
            Some(RelayMode::Custom) if urls.is_empty() => {
                r.fault("DIALER_RELAY=custom needs DIALER_RELAY_URLS")
            }
            _ => {}
        }
        let udp_bind = r.optional("DIALER_UDP_BIND");
        let quic_idle_timeout = r.secs("DIALER_QUIC_IDLE_TIMEOUT_SECS", 60);
        let quic_keepalive = r.secs("DIALER_QUIC_KEEPALIVE_SECS", 5);
        let response_timeout = r.secs("DIALER_RESPONSE_TIMEOUT_SECS", 100);
        let shutdown_grace = r.secs("DIALER_SHUTDOWN_GRACE_SECS", 280);
        if !r.faults.is_empty() {
            bail!(
                "the dialer cannot start. {} configuration fault(s):\n{}",
                r.faults.len(),
                r.faults
                    .iter()
                    .map(|f| format!("  - {f}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        Ok(Config {
            secret_key: secret_key.expect("checked"),
            secrets: Secrets {
                proxy: proxy.expect("checked"),
            },
            listen: listen.expect("checked"),
            relay: RelayConfig {
                mode: mode.expect("checked"),
                urls,
                n0_api_secret,
                token,
            },
            udp_bind,
            quic_idle_timeout,
            quic_keepalive,
            response_timeout,
            shutdown_grace,
        })
    }
}

/// Parses an endpoint secret key: 64 hex digits, the format of an
/// `amika-net` key file.
pub fn parse_secret_key(s: &str) -> Result<SecretKey> {
    let s = s.trim();
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("must be 64 hex digits");
    }
    let mut bytes = [0u8; 32];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        bytes[i] = u8::from_str_radix(std::str::from_utf8(pair)?, 16)?;
    }
    Ok(SecretKey::from_bytes(&bytes))
}

/// Formats a secret key as [`parse_secret_key`] reads it.
pub fn format_secret_key(key: &SecretKey) -> String {
    key.to_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

struct Reader<'a> {
    env: &'a dyn Fn(&str) -> Option<String>,
    faults: Vec<String>,
}

impl Reader<'_> {
    fn fault(&mut self, message: impl Into<String>) {
        self.faults.push(message.into());
    }

    fn optional(&self, name: &str) -> Option<String> {
        (self.env)(name).filter(|v| !v.is_empty())
    }

    fn required(&mut self, name: &str) -> Option<String> {
        let value = self.optional(name);
        if value.is_none() {
            self.fault(format!("{name} is required and must not be empty"));
        }
        value
    }

    fn secret_key(&mut self, name: &str) -> Option<SecretKey> {
        let raw = self.required(name)?;
        match parse_secret_key(&raw) {
            Ok(key) => Some(key),
            Err(e) => {
                // The value is a secret; never echo it.
                self.fault(format!("{name} {e}"));
                None
            }
        }
    }

    fn parsed<T: FromStr>(&mut self, name: &str, fallback: &str) -> Option<T>
    where
        T::Err: std::fmt::Display,
    {
        let raw = self.optional(name).unwrap_or_else(|| fallback.to_string());
        match raw.parse() {
            Ok(v) => Some(v),
            Err(e) => {
                self.fault(format!("{name}: {e}"));
                None
            }
        }
    }

    fn relay_urls(&mut self, name: &str) -> Vec<RelayUrl> {
        let Some(raw) = self.optional(name) else {
            return Vec::new();
        };
        let mut urls = Vec::new();
        for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            match RelayUrl::from_str(part) {
                Ok(url) if matches!(url.scheme(), "http" | "https") => urls.push(url),
                _ => self.fault(format!("{name} holds a value that is not an http(s) URL")),
            }
        }
        urls
    }

    fn secs(&mut self, name: &str, fallback: u64) -> Duration {
        let Some(raw) = self.optional(name) else {
            return Duration::from_secs(fallback);
        };
        match raw.trim().parse::<u64>() {
            Ok(n) if n > 0 => Duration::from_secs(n),
            _ => {
                self.fault(format!("{name} must be a whole number of seconds above 0"));
                Duration::from_secs(fallback)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    const KEY: &str = "0707070707070707070707070707070707070707070707070707070707070707";

    #[test]
    fn a_complete_environment_reads() {
        let c = Config::from_env(env(&[
            ("DIALER_SECRET_KEY", KEY),
            ("DIALER_PROXY_SECRET", "p"),
            ("DIALER_RELAY", "custom"),
            (
                "DIALER_RELAY_URLS",
                "https://a.example/, https://b.example/",
            ),
        ]))
        .unwrap();
        assert_eq!(c.relay.urls.len(), 2);
        assert_eq!(c.listen, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(format_secret_key(&c.secret_key), KEY);
    }

    #[test]
    fn every_fault_is_reported_and_no_secret_is_echoed() {
        let err = Config::from_env(env(&[
            ("DIALER_SECRET_KEY", "not-a-key-but-secret"),
            ("DIALER_RELAY", "n0-pro"),
            ("DIALER_QUIC_IDLE_TIMEOUT_SECS", "5s"),
        ]))
        .unwrap_err()
        .to_string();
        assert!(err.contains("4 configuration fault(s)"), "{err}");
        assert!(err.contains("DIALER_PROXY_SECRET is required"));
        assert!(err.contains("n0-pro needs"));
        assert!(!err.contains("not-a-key-but-secret"));
    }
}
