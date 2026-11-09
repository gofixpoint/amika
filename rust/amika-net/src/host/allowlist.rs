//! The test allowlist: a JSON file in place of hostd, for tests and network
//! measurements on a machine with no hostd.
//!
//! ```json
//! {
//!   "allowed_callers": ["<endpoint id>"],
//!   "hostd": "127.0.0.1:8080",
//!   "rigs": { "r1": { "22": "127.0.0.1:2222" } }
//! }
//! ```
//!
//! The host reads the file again at each check, so an edit applies to new
//! connections and streams. If the file does not parse, the last good copy
//! stays.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::RwLock,
};

use anyhow::{Context, Result};
use iroh::EndpointId;
use serde::Deserialize;
use tracing::warn;

use super::{Caller, PeerCheck};
use crate::header::{Refusal, Target};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    allowed_callers: Vec<EndpointId>,
    hostd: Option<SocketAddr>,
    /// Rig id to (port to TCP address).
    #[serde(default)]
    rigs: HashMap<String, HashMap<u16, SocketAddr>>,
}

pub struct Allowlist {
    path: PathBuf,
    last_good: RwLock<Config>,
}

impl Allowlist {
    pub fn load(path: &Path) -> Result<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            last_good: RwLock::new(read(path)?),
        })
    }

    pub fn check_peer(&self, peer: EndpointId) -> PeerCheck {
        if self.current().allowed_callers.contains(&peer) {
            PeerCheck::Allowed(Caller {
                kind: "device".into(),
                principal: None,
                service: None,
            })
        } else {
            PeerCheck::Refused
        }
    }

    pub fn open(&self, target: &Target) -> Result<SocketAddr, Refusal> {
        let config = self.current();
        match target {
            Target::Hostd => config.hostd.ok_or(Refusal::NotAllowed),
            Target::Rig { id, port } => config
                .rigs
                .get(id)
                .ok_or(Refusal::UnknownRig)?
                .get(port)
                .copied()
                .ok_or(Refusal::PortNotAllowed),
        }
    }

    fn current(&self) -> Config {
        match read(&self.path) {
            Ok(config) => {
                *self.last_good.write().expect("poisoned") = config.clone();
                config
            }
            Err(e) => {
                warn!(error = %format!("{e:#}"), "allowlist reload failed; keeping the last good copy");
                self.last_good.read().expect("poisoned").clone()
            }
        }
    }
}

fn read(path: &Path) -> Result<Config> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowlist_maps_known_targets_and_refuses_others() {
        let dir = std::env::temp_dir().join(format!("amika-net-allow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("allow.json");
        let caller = iroh::SecretKey::generate().public();
        std::fs::write(
            &path,
            format!(
                r#"{{"allowed_callers":["{caller}"],"rigs":{{"r1":{{"22":"127.0.0.1:2222"}}}}}}"#
            ),
        )
        .unwrap();
        let list = Allowlist::load(&path).unwrap();
        assert!(matches!(list.check_peer(caller), PeerCheck::Allowed(_)));
        let other = iroh::SecretKey::generate().public();
        assert_eq!(list.check_peer(other), PeerCheck::Refused);

        let rig = |id: &str, port| Target::Rig {
            id: id.into(),
            port,
        };
        assert_eq!(
            list.open(&rig("r1", 22)),
            Ok("127.0.0.1:2222".parse().unwrap())
        );
        assert_eq!(list.open(&rig("r1", 80)), Err(Refusal::PortNotAllowed));
        assert_eq!(list.open(&rig("r2", 22)), Err(Refusal::UnknownRig));
        assert_eq!(list.open(&Target::Hostd), Err(Refusal::NotAllowed));

        // A bad edit keeps the last good copy.
        std::fs::write(&path, "{").unwrap();
        assert!(matches!(list.check_peer(caller), PeerCheck::Allowed(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
