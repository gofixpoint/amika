//! `connect` through the agent to a `host` with a fake hostd, to a TCP echo
//! server, all on one machine. Clients dial by endpoint id and the host's
//! loopback address: no relay and no address lookup.

#![cfg(unix)]

mod common;

use std::{
    io::{Read, Write},
    process::Stdio,
    thread,
    time::Duration,
};

use common::{BIN, Bed, NetOpts};

const SECOND: Duration = Duration::from_secs(1);

#[test]
fn a_session_carries_bytes_both_ways_and_ends_cleanly() {
    let bed = Bed::new("bytes");
    let payload: Vec<u8> = (0..4 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
    let mut child = bed
        .connect_cmd("rig:r1:7", &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let sent = payload.clone();
    // Closing stdin ends the session: the echo server sees the end, and
    // closes its side.
    let writer = thread::spawn(move || stdin.write_all(&sent).unwrap());
    let mut echoed = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut echoed)
        .unwrap();
    writer.join().unwrap();
    let status = common::wait_timeout(&mut child, 10 * SECOND).expect("connect did not exit");
    assert!(status.success());
    assert_eq!(echoed.len(), payload.len());
    assert!(echoed == payload, "the echoed bytes differ");
}

#[test]
fn the_host_reports_ready_and_runs_check_1_once_per_connection() {
    let bed = Bed::new("checks");
    let ready = bed.hostd_messages("ready");
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0]["endpoint_id"], bed.host_id);
    assert_eq!(ready[0]["version"], env!("CARGO_PKG_VERSION"));

    let mut a = bed.session(&[], &[]);
    a.echo(10 * SECOND).unwrap();
    let mut b = bed.session(&[], &[]);
    b.echo(10 * SECOND).unwrap();
    assert!(a.close().success());
    assert!(b.close().success());

    // The agent carried both sessions on one connection.
    let checks = bed.hostd_messages("check_peer");
    assert_eq!(checks.len(), 1, "{checks:?}");
    assert_eq!(checks[0]["endpoint_id"], bed.client_id);
    let opens = bed.hostd_messages("open");
    assert_eq!(opens.len(), 2);
    assert!(opens.iter().all(|o| o["target"] == "rig:r1:7"));
}

#[test]
fn connect_exits_after_its_agent_closes_while_stdin_stays_open() {
    let bed = Bed::new("remote-end");
    let mut session = bed.session(&[], &[]);
    session.echo(10 * SECOND).unwrap();
    let pid = bed.status().unwrap().pid;
    // SAFETY: this is the child agent started by this test bed.
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    let status = common::wait_timeout(&mut session.child, 3 * SECOND);
    assert!(
        status.is_some(),
        "connect waited for stdin after its agent ended"
    );
}

#[test]
fn a_caller_that_hostd_refuses_gets_no_stream() {
    let bed = Bed::new("stranger");
    let other = bed.dir.join("other.key");
    let out = std::process::Command::new(BIN)
        .args(["id", "--key-file"])
        .arg(&other)
        .output()
        .unwrap();
    assert!(out.status.success());
    let out = bed
        .connect_cmd_as(&other, &bed.dir.join("agent2"), "rig:r1:7", &[])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = common::stderr(&out);
    assert!(err.contains("caller not allowed"), "{err}");
    assert!(bed.hostd_messages("open").is_empty());
}

#[test]
fn refusal_reasons_from_hostd_reach_connect() {
    let bed = Bed::new("reasons");
    for (target, reason) in [
        ("rig:r1:8", "port_not_allowed"),
        ("rig:r2:22", "unknown_rig"),
        ("hostd", "not_allowed"),
    ] {
        let out = bed.connect_cmd(target, &[]).output().unwrap();
        assert!(!out.status.success());
        let err = common::stderr(&out);
        assert!(err.contains(&format!("{target}: {reason}")), "{err}");
    }
}

#[test]
#[ignore = "needs the internet"]
fn a_session_goes_through_the_hosts_relay_with_no_lookup() {
    // The host homes on n0's public relays. The client has no relays of its
    // own: it adds the relay URL that the host reported, as in production.
    let bed = Bed::with(
        "relay",
        NetOpts {
            host: ["--relay", "n0", "--relay-only"].map(String::from).to_vec(),
            client: vec!["--relay-only".into()],
            host_addr: false,
        },
    );
    assert!(bed.host_relay.is_some());
    let mut s = bed.session(&[], &[]);
    s.echo(30 * SECOND).unwrap();
    s.echo_for(3 * SECOND, Duration::from_millis(100)).unwrap();
    assert!(s.close().success());
}

/// A session over n0 Pro relays, relay-only, while both ends refresh their
/// 20 s relay tokens. It runs past the first tokens' expiry. Needs the n0
/// project API secret and relay URLs in files:
///
/// ```sh
/// TEST_AMIKA_NET_N0_API_SECRET_FILE=... TEST_AMIKA_NET_N0_RELAY_URLS_FILE=... \
///   cargo test --test e2e n0_pro -- --ignored
/// ```
///
/// The relay URLs file has one URL per line. Neither value is printed.
#[test]
#[ignore = "needs the internet and the n0 project API secret"]
fn an_n0_pro_session_survives_relay_token_refreshes() {
    let (Ok(secret), Ok(urls)) = (
        std::env::var("TEST_AMIKA_NET_N0_API_SECRET_FILE"),
        std::env::var("TEST_AMIKA_NET_N0_RELAY_URLS_FILE"),
    ) else {
        panic!("set TEST_AMIKA_NET_N0_API_SECRET_FILE and TEST_AMIKA_NET_N0_RELAY_URLS_FILE");
    };
    let n0_pro = [
        "--relay",
        "n0-pro",
        "--api-secret-file",
        &secret,
        "--relay-only",
        "--test-relay-token-ttl-secs",
        "20",
    ]
    .map(String::from)
    .to_vec();
    let mut host = n0_pro.clone();
    for url in std::fs::read_to_string(&urls).unwrap().lines() {
        if !url.trim().is_empty() {
            host.extend(["--relay-url".to_string(), url.trim().to_string()]);
        }
    }
    let bed = Bed::with(
        "n0pro",
        NetOpts {
            host,
            client: n0_pro,
            host_addr: false,
        },
    );
    let mut s = bed.session(&[], &[]);
    s.echo(30 * SECOND).unwrap();
    // 45 s: two refreshes, and past the first tokens' expiry.
    let n = s.echo_for(45 * SECOND, Duration::from_millis(500)).unwrap();
    assert!(n > 50);
    let host_log = std::fs::read_to_string(bed.dir.join("host.log")).unwrap();
    assert!(host_log.matches("relay token refreshed").count() >= 2);
    assert!(bed.agent_log().matches("relay token refreshed").count() >= 2);
    // A new session after the first tokens expired.
    assert!(s.close().success());
    let mut s = bed.session(&[], &[]);
    s.echo(30 * SECOND).unwrap();
    assert!(s.close().success());
}
