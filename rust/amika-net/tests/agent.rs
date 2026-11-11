//! The per-user agent, end to end on one machine with no relay: the host
//! role in front of a TCP echo server, and `connect` processes through an
//! agent that they start themselves.

#![cfg(unix)]

mod common;

use std::{os::unix::net::UnixListener, thread, time::Duration};

use common::{Bed, alive, wait_until};

const SECOND: Duration = Duration::from_secs(1);

#[test]
fn concurrent_sessions_share_one_auto_started_agent() {
    let bed = Bed::new("share");
    assert_eq!(bed.status(), None);
    let mut a = bed.session(&[], &[]);
    a.echo(10 * SECOND).unwrap();
    let mut b = bed.session(&[], &[]);
    b.echo(10 * SECOND).unwrap();

    let status = bed.status().unwrap();
    assert_eq!(status.streams, 2);
    // Both sessions keep working while both are open.
    for _ in 0..20 {
        a.echo(5 * SECOND).unwrap();
        b.echo(5 * SECOND).unwrap();
    }
    assert!(a.close().success());
    assert!(b.close().success());
    assert_eq!(bed.agents_started(), 1);
    let log = bed.agent_log();
    // One QUIC connection to the host carried both streams.
    assert_eq!(log.matches(" connected host=").count(), 1, "{log}");
}

#[test]
fn racing_connects_start_one_agent() {
    let bed = Bed::new("race");
    let mut sessions: Vec<_> = (0..6).map(|_| bed.session(&[], &[])).collect();
    for s in &mut sessions {
        s.echo(20 * SECOND).unwrap();
    }
    assert_eq!(bed.agents_started(), 1, "{}", bed.agent_log());
    assert_eq!(bed.status().unwrap().streams, 6);
    for s in sessions {
        assert!(s.close().success());
    }
}

#[test]
fn agent_exits_when_idle() {
    let bed = Bed::new("idle");
    let mut s = bed.session(&["--agent-idle-exit-secs", "2"], &[]);
    s.echo(10 * SECOND).unwrap();
    let pid = bed.status().unwrap().pid;
    // An open session keeps the agent past its idle period.
    thread::sleep(3 * SECOND);
    s.echo(5 * SECOND).unwrap();
    assert!(alive(pid));
    assert!(s.close().success());
    wait_until("the idle agent exits", 10 * SECOND, || !alive(pid));
    assert!(!bed.socket().exists());
    assert!(bed.agent_log().contains("reason=\"idle\""));
}

#[test]
fn upgrade_with_the_same_protocol_keeps_one_agent_and_retires_the_old_one() {
    let bed = Bed::new("upgr");
    let mut old = bed.session(&[], &[]);
    old.echo(10 * SECOND).unwrap();
    let old_agent = bed.status().unwrap();

    // A newer build with the same protocol uses the old agent while it has
    // streams, so there is never a second endpoint with this key.
    let new_build = [("TEST_AMIKA_NET_BUILD", "99.0.0")];
    let mut new = bed.session(&[], &new_build);
    new.echo(10 * SECOND).unwrap();
    let status = bed.status().unwrap();
    assert_eq!(status.pid, old_agent.pid);
    assert!(status.retiring);
    old.echo_for(2 * SECOND, Duration::from_millis(50)).unwrap();

    // The old agent exits after its last stream, and the next connect
    // starts the new build.
    assert!(old.close().success());
    new.echo(5 * SECOND).unwrap();
    assert!(new.close().success());
    wait_until("the old agent exits", 10 * SECOND, || !alive(old_agent.pid));
    let mut next = bed.session(&[], &new_build);
    next.echo(10 * SECOND).unwrap();
    let status = bed.status().unwrap();
    assert_ne!(status.pid, old_agent.pid);
    assert_eq!(status.build, "99.0.0");
    assert!(next.close().success());
}

#[test]
fn upgrade_with_a_new_protocol_starts_a_new_agent_while_the_old_session_continues() {
    let bed = Bed::new("proto");
    let mut old = bed.session(&[], &[]);
    old.echo(10 * SECOND).unwrap();
    let old_agent = bed.status().unwrap();

    let new_proto = [("TEST_AMIKA_NET_AGENT_PROTO", "2")];
    let mut new = bed.session(&[], &new_proto);
    new.echo(10 * SECOND).unwrap();
    assert_eq!(bed.agents_started(), 2);
    assert!(alive(old_agent.pid), "the old agent must finish its stream");
    let new_agent = bed.status_with(&new_proto).unwrap();
    assert_ne!(new_agent.pid, old_agent.pid);

    // The old session goes on through the draining agent.
    old.echo_for(2 * SECOND, Duration::from_millis(50)).unwrap();
    new.echo(5 * SECOND).unwrap();
    assert!(old.close().success());
    wait_until("the old agent exits", 10 * SECOND, || !alive(old_agent.pid));
    // The old agent did not remove the new agent's socket.
    assert_eq!(bed.status_with(&new_proto).unwrap().pid, new_agent.pid);
    new.echo(5 * SECOND).unwrap();
    assert!(new.close().success());
}

#[test]
fn a_stale_socket_is_removed() {
    let bed = Bed::new("stale");
    std::fs::create_dir_all(&bed.agent_dir).unwrap();
    std::fs::set_permissions(
        &bed.agent_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    drop(UnixListener::bind(bed.socket()).unwrap());
    assert!(bed.socket().exists());

    let mut s = bed.session(&[], &[]);
    s.echo(10 * SECOND).unwrap();
    assert!(s.stderr().contains("removed a stale agent socket"));
    assert!(s.close().success());
}

#[test]
fn a_killed_agent_is_replaced() {
    let bed = Bed::new("kill");
    let mut s = bed.session(&[], &[]);
    s.echo(10 * SECOND).unwrap();
    let pid = bed.status().unwrap().pid;
    // SAFETY: kills the agent this test started.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    wait_until("the agent dies", 5 * SECOND, || !alive(pid));
    assert!(bed.socket().exists(), "SIGKILL leaves the socket");
    let _ = s.close();

    let mut s = bed.session(&[], &[]);
    s.echo(10 * SECOND).unwrap();
    assert_ne!(bed.status().unwrap().pid, pid);
    assert!(s.close().success());
}

#[test]
fn agent_stop_drains_then_exits() {
    let bed = Bed::new("stop");
    let mut s = bed.session(&[], &[]);
    s.echo(10 * SECOND).unwrap();
    let pid = bed.status().unwrap().pid;
    let out = bed.stop_agent();
    assert!(out.status.success(), "{}", common::stderr(&out));
    assert!(!bed.socket().exists());
    s.echo_for(SECOND, Duration::from_millis(50)).unwrap();
    assert!(alive(pid));
    assert!(s.close().success());
    wait_until("the stopped agent exits", 10 * SECOND, || !alive(pid));
}

#[test]
fn a_host_refusal_reaches_connect() {
    let bed = Bed::new("refuse");
    let out = bed.connect_cmd("rig:r1:8", &[]).output().unwrap();
    assert!(!out.status.success());
    assert!(common::stderr(&out).contains("rig:r1:8: port_not_allowed"));
    // The refused stream did not hurt the agent.
    let mut s = bed.session(&[], &[]);
    s.echo(10 * SECOND).unwrap();
    assert!(s.close().success());
    assert_eq!(bed.agents_started(), 1);
}

#[test]
fn direct_mode_still_works_without_an_agent() {
    let bed = Bed::new("direct");
    let mut s = bed.session(&["--direct"], &[]);
    s.echo(10 * SECOND).unwrap();
    assert!(s.close().success());
    assert_eq!(bed.status(), None);
    assert_eq!(bed.agents_started(), 0);
}

#[test]
fn the_agent_directory_must_be_private() {
    let bed = Bed::new("perm");
    std::fs::create_dir_all(&bed.agent_dir).unwrap();
    std::fs::set_permissions(
        &bed.agent_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let out = bed.connect_cmd("rig:r1:7", &[]).output().unwrap();
    assert!(!out.status.success());
    assert!(common::stderr(&out).contains("must be 700"));
}
