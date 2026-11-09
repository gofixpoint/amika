//! The peer user check on the agent's socket. The agent refuses a client
//! that runs as another user, and a client refuses an agent that runs as
//! another user. The kernel reports the peer's user id: `SO_PEERCRED` on
//! Linux, `getpeereid` on macOS (through tokio's `peer_cred`).

use anyhow::{Context, Result, bail};
use tokio::net::UnixStream;

use super::rundir::current_uid;

/// Fails unless the process at the other end of `stream` runs as this
/// process's effective user.
pub fn check_same_user(stream: &UnixStream) -> Result<()> {
    let peer = stream
        .peer_cred()
        .context("reading the peer's credentials")?;
    check_uid(peer.uid(), current_uid())
}

fn check_uid(peer: u32, me: u32) -> Result<()> {
    if peer != me {
        bail!("peer runs as uid {peer}, not as this user (uid {me})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_uid_is_refused() {
        assert!(check_uid(1000, 1000).is_ok());
        assert!(check_uid(1001, 1000).is_err());
        assert!(check_uid(0, 1000).is_err());
    }

    #[tokio::test]
    async fn a_socket_pair_of_this_process_is_the_same_user() {
        let (a, b) = UnixStream::pair().unwrap();
        check_same_user(&a).unwrap();
        check_same_user(&b).unwrap();
    }
}
