//! The dialer's process: read the configuration, bind the iroh endpoint,
//! serve HTTP until a signal, then drain.

use std::time::Duration;

use amika_dialer::{
    config::{self, Config},
    endpoint,
    pool::{Pool, PoolOptions},
    server::{self, Dialer},
};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use iroh::SecretKey;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "amika-dialer",
    version,
    about = "Serves amika.run requests for hosts on the iroh transport"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Serve HTTP. The default. Reads its configuration from `DIALER_*`.
    Serve,
    /// Print a new endpoint secret key (for `DIALER_SECRET_KEY`) on stdout,
    /// and its endpoint id on stderr.
    Keygen,
    /// Print the endpoint id of `DIALER_SECRET_KEY`.
    EndpointId,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::Serve => serve().await,
        Cmd::Keygen => {
            let key = SecretKey::generate();
            println!("{}", config::format_secret_key(&key));
            eprintln!("endpoint id: {}", key.public());
            Ok(())
        }
        Cmd::EndpointId => {
            let raw = std::env::var("DIALER_SECRET_KEY").context("DIALER_SECRET_KEY is not set")?;
            let key = config::parse_secret_key(&raw).context("DIALER_SECRET_KEY")?;
            println!("{}", key.public());
            Ok(())
        }
    }
}

async fn serve() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("DIALER_LOG")
                .unwrap_or_else(|_| "amika_dialer=info,iroh=warn".into()),
        )
        .with_ansi(false)
        .init();
    let config = Config::from_env(|k| std::env::var(k).ok())?;
    info!(?config, "starting");
    let ep = endpoint::bind(&config).await?;
    info!(endpoint_id = %ep.id(), sockets = ?ep.bound_sockets(), "endpoint bound");
    let ep2 = ep.clone();
    tokio::spawn(async move { endpoint::report_online(&ep2, Duration::from_secs(15)).await });

    let pool = Pool::new(ep.clone(), PoolOptions::default());
    tokio::spawn(pool.clone().reap());
    let dialer = Dialer::new(
        pool,
        config.secrets.clone(),
        config.relay.urls.clone(),
        config.response_timeout,
    );
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("binding {}", config.listen))?;
    info!(listen = %listener.local_addr()?, "serving");
    server::serve(listener, dialer, shutdown_signal(), config.shutdown_grace).await?;
    ep.close().await;
    Ok(())
}

/// Resolves on SIGTERM (a deploy) or Ctrl-C.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("installing SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal");
}
