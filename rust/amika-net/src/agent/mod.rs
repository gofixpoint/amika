//! The per-user agent.
//!
//! An iroh endpoint key can be live in one process only: the relay gives
//! relayed packets for an endpoint id only to the newest connection with
//! that id. So the device key lives in one agent process per user, and each
//! `connect` (one per SSH session) asks the agent for a stream over a local
//! Unix socket. The agent reuses one QUIC connection per host. It works
//! like OpenSSH's `ControlMaster`: `connect` starts it when needed, and it
//! exits when idle.
//!
//! Choices, and why:
//!
//! - **Socket.** `agent.sock` in `$XDG_RUNTIME_DIR/amika-net`, else in
//!   `amika/amika-net` under the user's cache directory (macOS, and Linux
//!   with no runtime directory). The directory is mode 0700 and must be the
//!   user's; the socket is mode 0600. Each side checks that the peer runs as
//!   the same user. The agent never listens on TCP.
//! - **Start lock.** `agent.lock` in the same directory, an advisory
//!   `flock`. A client takes it only to start an agent: it removes a stale
//!   socket, starts the agent, and waits until the agent listens. The kernel
//!   drops the lock if the client dies.
//! - **Idle exit.** 10 minutes with no clients, set with
//!   `--idle-exit-secs` (or `connect --agent-idle-exit-secs`).
//! - **Versions.** The hellos carry a protocol range, the build, and the
//!   agent config (key file and endpoint options); see [`proto::decide`].
//!   A new build that speaks the agent's protocol uses the old agent while
//!   it has streams, and the old agent exits after its last one. So an
//!   upgrade never runs two agents with one key, and never cuts a session.
//!   Only an incompatible protocol or another config starts a new agent
//!   while the old one drains; then the old agent's relayed sessions can
//!   lose the relay (its direct paths are unaffected).
//! - **Logs.** `amika/amika-net/agent.log` in the user's state directory,
//!   never the socket. It is moved to `agent.log.1` at start above 10 MiB.
//!
//! Windows is out of scope: this module is Unix only, and `connect` there
//! dials directly. A Windows agent needs a named pipe with a DACL for the
//! user's SID only, `GetNamedPipeClientProcessId` plus the process token
//! for the peer check, a named mutex or `LockFileEx` for the start lock,
//! `DETACHED_PROCESS` for the start, and the same protocol on top.

pub mod client;
pub mod frame;
mod peer;
pub mod proto;
pub mod rundir;
pub mod server;

use std::path::{Path, PathBuf};

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::net::{self, EndpointArgs, RelayChoice};

/// The agent exits after this many seconds with no clients.
pub const DEFAULT_IDLE_EXIT_SECS: u64 = 600;

#[derive(Debug, Subcommand)]
pub enum AgentCmd {
    /// Run the agent in this process. `connect` starts it this way.
    Run(server::RunArgs),
    /// Print the running agent's build, pid, endpoint id and open streams.
    Status(ControlArgs),
    /// Stop the running agent: it takes no new streams, and exits when its
    /// open streams end.
    Stop(ControlArgs),
}

#[derive(Debug, Clone, Args)]
pub struct ControlArgs {
    /// The agent's directory (socket and start lock).
    #[arg(long, env = "AMIKA_NET_AGENT_DIR")]
    pub agent_dir: Option<PathBuf>,
}

pub async fn run(cmd: AgentCmd) -> Result<()> {
    let (args, request) = match cmd {
        AgentCmd::Run(args) => return server::run(args).await,
        AgentCmd::Status(args) => (args, None),
        AgentCmd::Stop(args) => (args, Some(proto::Request::Stop)),
    };
    match client::control(args.agent_dir.as_deref(), request).await? {
        None => println!("no agent is running"),
        Some(a) => println!(
            "build {}\npid {}\nendpoint {}\nstreams {}\nretiring {}",
            a.build, a.pid, a.endpoint, a.streams, a.retiring
        ),
    }
    Ok(())
}

/// The agent config: the key file and endpoint options. A client and an
/// agent with different configs never share the agent.
pub fn agent_config(key_file: &Path, net: &EndpointArgs, relay: RelayChoice) -> Result<String> {
    let mut parts = vec!["--key-file".to_string(), net::absolute(key_file)?];
    parts.extend(net.to_args(relay)?);
    Ok(parts.join(" "))
}
