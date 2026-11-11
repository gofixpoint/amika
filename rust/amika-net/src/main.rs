//! The `amika-net` command line. The roles live in the library.

use std::{io::IsTerminal, path::PathBuf};

use amika_net::{VERSION, connect, keys};
#[cfg(unix)]
use amika_net::{agent, host};
use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "amika-net",
    version = VERSION,
    about = "SSH and TCP streams to Amika hosts over iroh"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

// Without the Unix-only roles, `Connect` is much larger than `Id`. The value
// is parsed once.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Subcommand)]
enum Cmd {
    /// Print the endpoint id of a key file. Makes the file if it is missing.
    Id {
        #[arg(long)]
        key_file: PathBuf,
    },
    /// Run the host role beside hostd.
    #[cfg(unix)]
    Host(host::HostArgs),
    /// Open a stream to a target on a host, and pipe stdin and stdout
    /// through it (SSH ProxyCommand).
    Connect(connect::ConnectArgs),
    /// The per-user agent that holds the device key for `connect`.
    #[cfg(unix)]
    #[command(subcommand)]
    Agent(agent::AgentCmd),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli.cmd)?;
    let connect = matches!(&cli.cmd, Cmd::Connect(_));
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(run(cli));
    // Tokio's stdin read can stay blocked after the remote stream ends.
    // Connect must exit without waiting for that read to finish.
    if connect {
        runtime.shutdown_background();
    }
    result
}

async fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Id { key_file } => {
            println!("{}", keys::load_or_create(&key_file)?.public());
            Ok(())
        }
        #[cfg(unix)]
        Cmd::Host(args) => host::run(args).await,
        Cmd::Connect(args) => connect::run(args).await,
        #[cfg(unix)]
        Cmd::Agent(cmd) => agent::run(cmd).await,
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
