//! amika-net: a spike prototype of the iroh transport in spec 035.
//!
//! Roles:
//! - `host` accepts QUIC streams and forwards each to a TCP target.
//! - `connect` is the SSH `ProxyCommand` on a caller. It goes through the
//!   per-user `agent`, which holds the device key.
//! - `probe` and `dial` are measurement modes for the spike.

#[cfg(unix)]
mod agent;
mod connect;
mod frame;
mod header;
mod host;
mod keys;
mod net;
mod paths;
mod pipe;
mod probe;

use std::{io::IsTerminal, path::PathBuf};

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "amika-net",
    version,
    about = "SSH and TCP streams to Amika hosts over iroh (spike)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Make a key file if it is missing, and print its endpoint id.
    Id {
        #[arg(long)]
        key_file: PathBuf,
    },
    /// Run the host role.
    Host(host::HostArgs),
    /// Dial a host and pipe stdin and stdout to a target (SSH ProxyCommand).
    Connect(connect::ConnectArgs),
    /// The per-user agent that holds the device key for `connect`.
    #[cfg(unix)]
    #[command(subcommand)]
    Agent(agent::AgentCmd),
    /// Make many short connections and report the path of each (test 3).
    Probe(probe::ProbeArgs),
    /// Run as a long-lived dialer that reports path and RTT (test 6).
    Dial(probe::DialArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli.cmd)?;
    match cli.cmd {
        Cmd::Id { key_file } => {
            println!("{}", keys::load_or_create(&key_file)?.public());
            Ok(())
        }
        Cmd::Host(args) => host::run(args).await,
        Cmd::Connect(args) => connect::run(args).await,
        #[cfg(unix)]
        Cmd::Agent(cmd) => agent::run(cmd).await,
        Cmd::Probe(args) => probe::run_probe(args).await,
        Cmd::Dial(args) => probe::run_dial(args).await,
    }
}

/// Sends logs to stderr, except for the agent, which logs to its file.
/// In connect mode, stdout carries the SSH bytes, so logs never go there.
fn init_logging(cmd: &Cmd) -> Result<()> {
    let filter = EnvFilter::try_from_env("AMIKA_NET_LOG")
        .unwrap_or_else(|_| "amika_net=info,iroh=warn".into());
    #[cfg(unix)]
    if let Cmd::Agent(agent::AgentCmd::Run(args)) = cmd {
        let path = match &args.log_file {
            Some(p) => p.clone(),
            None => agent::rundir::default_log_file(|k| std::env::var_os(k))?,
        };
        let file = agent::server::open_log(&path)?;
        tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false)
            .with_env_filter(filter)
            .init();
        return Ok(());
    }
    let _ = cmd;
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_env_filter(filter)
        .init();
    Ok(())
}
