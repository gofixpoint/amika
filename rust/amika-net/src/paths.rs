//! Path reporting: whether a connection is direct or relayed, its RTT, and
//! each path change.

use std::time::Duration;

use iroh::{
    TransportAddr,
    endpoint::{Connection, PathEvent},
};
use n0_future::StreamExt;
use serde::Serialize;
use tracing::info;

/// The kind of the selected path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Direct,
    Relay,
    Other,
    None,
}

/// A snapshot of a connection's selected path.
#[derive(Debug, Clone, Serialize)]
pub struct Selected {
    pub kind: PathKind,
    pub remote: String,
    pub rtt_ms: Option<f64>,
    pub open_paths: usize,
}

/// Returns the connection's selected path now.
pub fn selected(conn: &Connection) -> Selected {
    let paths = conn.paths();
    let open_paths = paths.len();
    match paths.iter().find(|p| p.is_selected()) {
        Some(p) => Selected {
            kind: kind_of(p.remote_addr()),
            remote: describe(p.remote_addr()),
            rtt_ms: Some(ms(p.rtt())),
            open_paths,
        },
        None => Selected {
            kind: PathKind::None,
            remote: String::new(),
            rtt_ms: None,
            open_paths,
        },
    }
}

/// Logs every path event of `conn`, with the selected path after each one,
/// until the connection closes.
pub fn spawn_logger(conn: &Connection, label: &'static str) {
    let mut events = conn.path_events();
    let weak = conn.weak_handle();
    tokio::spawn(async move {
        while let Some(event) = events.next().await {
            let (what, addr) = match &event {
                PathEvent::Opened { remote_addr, .. } => ("opened", Some(remote_addr)),
                PathEvent::Closed { remote_addr, .. } => ("closed", Some(remote_addr)),
                PathEvent::Selected { remote_addr, .. } => ("selected", Some(remote_addr)),
                PathEvent::Lagged { .. } => ("lagged", None),
                _ => ("other", None),
            };
            let Some(conn) = weak.upgrade() else { break };
            let now = selected(&conn);
            info!(
                conn = label,
                event = what,
                path = ?addr.map(kind_of),
                addr = %addr.map(describe).unwrap_or_default(),
                selected = ?now.kind,
                selected_addr = %now.remote,
                rtt_ms = ?now.rtt_ms,
                open_paths = now.open_paths,
                "path event"
            );
        }
    });
}

pub fn kind_of(addr: &TransportAddr) -> PathKind {
    if addr.is_ip() {
        PathKind::Direct
    } else if addr.is_relay() {
        PathKind::Relay
    } else {
        PathKind::Other
    }
}

fn describe(addr: &TransportAddr) -> String {
    addr.to_string()
}

pub fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0 * 100.0).round() / 100.0
}
