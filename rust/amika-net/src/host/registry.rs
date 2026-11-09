//! The open connections, by caller, so that `revoke` can close them.
//!
//! A revoke can arrive while check 1 for the same caller waits for hostd.
//! hostd answered that check with its old rules, so the connection must not
//! open. The registry counts revokes: a connection takes the count before
//! check 1, and registers only if its caller was not revoked since.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use iroh::{EndpointId, endpoint::Connection};

/// QUIC close code for a revoked caller.
pub const CLOSE_REVOKED: u32 = 403;

#[derive(Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    /// How many revokes there were.
    revokes: u64,
    peers: HashMap<EndpointId, Peer>,
}

#[derive(Default)]
struct Peer {
    /// The revoke count at this caller's last revoke. 0: never revoked.
    revoked_at: u64,
    conns: HashMap<u64, Connection>,
}

/// A registered connection. Dropping it removes the connection.
pub struct Registered {
    registry: Arc<Registry>,
    peer: EndpointId,
    id: u64,
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// The revoke count now. Take it before check 1.
    pub fn epoch(&self) -> u64 {
        self.inner.lock().expect("poisoned").revokes
    }

    /// Adds `conn`, unless its caller was revoked after `epoch`.
    pub fn register(self: &Arc<Self>, conn: &Connection, epoch: u64) -> Option<Registered> {
        let peer = conn.remote_id();
        let mut inner = self.inner.lock().expect("poisoned");
        inner.next_id += 1;
        let id = inner.next_id;
        let entry = inner.peers.entry(peer).or_default();
        if entry.revoked_at > epoch {
            return None;
        }
        entry.conns.insert(id, conn.clone());
        Some(Registered {
            registry: self.clone(),
            peer,
            id,
        })
    }

    /// Closes every connection from `peers`, and refuses the connections of
    /// these peers whose check 1 runs now. Returns how many it closed.
    pub fn revoke(&self, peers: &[EndpointId]) -> usize {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.revokes += 1;
        let at = inner.revokes;
        let mut closed = 0;
        for peer in peers {
            let entry = inner.peers.entry(*peer).or_default();
            entry.revoked_at = at;
            for (_, conn) in entry.conns.drain() {
                conn.close(CLOSE_REVOKED.into(), b"access revoked");
                closed += 1;
            }
        }
        closed
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        let mut inner = self.registry.inner.lock().expect("poisoned");
        if let Some(entry) = inner.peers.get_mut(&self.peer) {
            entry.conns.remove(&self.id);
            if entry.conns.is_empty() && entry.revoked_at == 0 {
                inner.peers.remove(&self.peer);
            }
        }
    }
}
