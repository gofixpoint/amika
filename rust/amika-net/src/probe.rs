//! Spike measurement modes, both against the host's `echo` target.
//!
//! - `probe`: many short connections, each from a new endpoint (a new UDP
//!   socket, so a new NAT mapping). Reports the path kind at a fixed time
//!   after the dial starts (test 3).
//! - `dial`: one long-lived endpoint, the way the dialer runs. Reconnects on
//!   a period and reports path kind and RTT on an interval (test 6).
//!
//! Both print one JSON object per line on stdout.

use std::{
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use clap::Args;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use serde_json::json;
use tracing::warn;

use crate::{
    connect::{self, HostAddrArgs},
    header::Target,
    net,
    paths::{self, PathKind},
};

#[derive(Debug, Clone, Args)]
pub struct ProbeArgs {
    /// This device's key file (must be on the host's allowlist).
    #[arg(long)]
    pub key_file: Option<PathBuf>,
    #[command(flatten)]
    pub host: HostAddrArgs,
    /// Number of connections.
    #[arg(long, default_value_t = 50)]
    pub count: u32,
    /// Seconds after the dial starts at which to record the path.
    #[arg(long, default_value_t = 10)]
    pub wait_secs: u64,
    /// Free text copied into each output line, to label the run.
    #[arg(long, default_value = "")]
    pub label: String,
    #[command(flatten)]
    pub net: net::NetArgs,
}

#[derive(Debug, Clone, Args)]
pub struct DialArgs {
    #[arg(long)]
    pub key_file: Option<PathBuf>,
    #[command(flatten)]
    pub host: HostAddrArgs,
    /// Seconds between reports.
    #[arg(long, default_value_t = 10)]
    pub interval_secs: u64,
    /// Seconds before the dialer closes the connection and dials again.
    #[arg(long, default_value_t = 120)]
    pub reconnect_secs: u64,
    #[arg(long, default_value = "")]
    pub label: String,
    #[command(flatten)]
    pub net: net::NetArgs,
}

pub async fn run_probe(args: ProbeArgs) -> Result<()> {
    let mut direct = 0u32;
    let mut failed = 0u32;
    for seq in 1..=args.count {
        let line = match probe_once(&args).await {
            Ok(line) => line,
            Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
        };
        if line["ok"] == false {
            failed += 1;
        } else if line["kind_at_wait"] == "direct" {
            direct += 1;
        }
        emit(&args.label, "probe", json!({ "seq": seq, "result": line }));
        // Let the host forget this caller's paths before the next probe.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    emit(
        &args.label,
        "probe-summary",
        json!({ "count": args.count, "direct": direct, "failed": failed }),
    );
    Ok(())
}

async fn probe_once(args: &ProbeArgs) -> Result<serde_json::Value> {
    let secret = connect::device_key(args.key_file.as_deref())?;
    let ep = net::builder(&args.net, secret).await?.bind().await?;
    let started = Instant::now();
    let result = async {
        let conn = connect::dial(&ep, &args.host).await?;
        let connect_ms = paths::ms(started.elapsed());
        let (mut send, mut recv) = connect::open_target(&conn, &Target::Echo).await?;
        let deadline = started + Duration::from_secs(args.wait_secs);
        let mut first_direct_ms = None;
        let mut rtts = Vec::new();
        while Instant::now() < deadline {
            if first_direct_ms.is_none() && paths::selected(&conn).kind == PathKind::Direct {
                first_direct_ms = Some(paths::ms(started.elapsed()));
            }
            rtts.push(ping(&mut send, &mut recv).await?);
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let at_wait = paths::selected(&conn);
        let tail: Vec<f64> = rtts.iter().rev().take(10).copied().collect();
        conn.close(0u32.into(), b"probe done");
        anyhow::Ok(json!({
            "ok": true,
            "connect_ms": connect_ms,
            "first_direct_ms": first_direct_ms,
            "kind_at_wait": at_wait.kind,
            "path_rtt_ms_at_wait": at_wait.rtt_ms,
            "open_paths_at_wait": at_wait.open_paths,
            "app_rtt_ms_median_last10": median(tail),
        }))
    }
    .await;
    ep.close().await;
    result
}

pub async fn run_dial(args: DialArgs) -> Result<()> {
    let secret = connect::device_key(args.key_file.as_deref())?;
    let ep = net::builder(&args.net, secret).await?.bind().await?;
    net::spawn_home_relay_logger(&ep);
    net::report_online(&ep, Duration::from_secs(15)).await;
    if let Some(r) = iroh::Watcher::get(&mut ep.net_report()) {
        emit(
            &args.label,
            "net-report",
            json!({
                "udp_v4": r.udp_v4,
                "udp_v6": r.udp_v6,
                "mapping_varies_by_dest": r.mapping_varies_by_dest(),
                "preferred_relay": r.preferred_relay.map(|u| u.to_string()),
            }),
        );
    }
    let mut conn_seq = 0u64;
    loop {
        conn_seq += 1;
        if let Err(e) = dial_session(&ep, &args, conn_seq).await {
            warn!(error = %format!("{e:#}"), "dial session failed");
            emit(
                &args.label,
                "dial-error",
                json!({ "conn_seq": conn_seq, "error": format!("{e:#}") }),
            );
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
}

async fn dial_session(ep: &iroh::Endpoint, args: &DialArgs, conn_seq: u64) -> Result<()> {
    let started = Instant::now();
    let conn = connect::dial(ep, &args.host).await?;
    paths::spawn_logger(&conn, "dial");
    let (mut send, mut recv) = connect::open_target(&conn, &Target::Echo).await?;
    emit(
        &args.label,
        "dial-connected",
        json!({ "conn_seq": conn_seq, "connect_ms": paths::ms(started.elapsed()) }),
    );
    let reconnect = Duration::from_secs(args.reconnect_secs);
    while started.elapsed() < reconnect {
        tokio::time::sleep(Duration::from_secs(args.interval_secs)).await;
        report(&args.label, &conn, conn_seq, started, &mut send, &mut recv).await?;
    }
    conn.close(0u32.into(), b"reconnect");
    Ok(())
}

async fn report(
    label: &str,
    conn: &Connection,
    conn_seq: u64,
    started: Instant,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Result<()> {
    let app_rtt_ms = ping(send, recv).await?;
    let sel = paths::selected(conn);
    emit(
        label,
        "dial-report",
        json!({
            "conn_seq": conn_seq,
            "since_connect_s": started.elapsed().as_secs(),
            "kind": sel.kind,
            "path_rtt_ms": sel.rtt_ms,
            "app_rtt_ms": app_rtt_ms,
            "open_paths": sel.open_paths,
        }),
    );
    Ok(())
}

/// Sends 8 bytes on the echo stream and waits for them. Returns the RTT in ms.
async fn ping(send: &mut SendStream, recv: &mut RecvStream) -> Result<f64> {
    let t = Instant::now();
    let payload = (t.elapsed().as_nanos() as u64).to_be_bytes();
    send.write_all(&payload).await?;
    let mut back = [0u8; 8];
    recv.read_exact(&mut back).await.context("echo read")?;
    Ok(paths::ms(t.elapsed()))
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

fn emit(label: &str, kind: &str, mut body: serde_json::Value) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    body["ts"] = json!(ts);
    body["type"] = json!(kind);
    body["label"] = json!(label);
    println!("{body}");
}
