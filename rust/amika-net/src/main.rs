//! amika-net: a spike prototype of the iroh transport in spec 035.
//!
//! Roles:
//! - `host` accepts QUIC streams and forwards each to a TCP target.
//! - `connect` is the SSH `ProxyCommand` on a caller.
//! - `probe` and `dial` are measurement modes for the spike.

mod connect;
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
    /// Make many short connections and report the path of each (test 3).
    Probe(probe::ProbeArgs),
    /// Run as a long-lived dialer that reports path and RTT (test 6).
    Dial(probe::DialArgs),
    /// Measure throughput from a byte source, over many streams or
    /// connections from one endpoint (test 9).
    Sink(probe::SinkArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    // Logs go to stderr: in connect mode, stdout carries the SSH bytes.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_env_filter(
            EnvFilter::try_from_env("AMIKA_NET_LOG")
                .unwrap_or_else(|_| "amika_net=info,iroh=warn".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Id { key_file } => {
            println!("{}", keys::load_or_create(&key_file)?.public());
            Ok(())
        }
        Cmd::Host(args) => host::run(args).await,
        Cmd::Connect(args) => connect::run(args).await,
        Cmd::Probe(args) => probe::run_probe(args).await,
        Cmd::Dial(args) => probe::run_dial(args).await,
        Cmd::Sink(args) => probe::run_sink(args).await,
    }
}
