//! The bug the agent fixes: two processes with one endpoint key collide at
//! the relay. These tests need the internet (n0's public relays), so they
//! are ignored by default. Run them with:
//!
//! ```sh
//! cargo test --test collision -- --ignored --nocapture
//! ```
//!
//! Both ends are relay-only, so every packet crosses the relay. A session on
//! a direct path does not depend on the relay and would hide the collision.

#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Bed, NetOpts};

const SECOND: Duration = Duration::from_secs(1);

fn relay_only() -> NetOpts {
    let flags = ["--relay", "n0", "--relay-only"].map(String::from).to_vec();
    NetOpts {
        host: flags.clone(),
        client: flags,
        host_addr: false,
    }
}

#[test]
#[ignore = "needs the internet"]
fn two_direct_connects_with_one_key_collide() {
    let bed = Bed::with("coll-d", relay_only());
    let mut first = bed.session(&["--direct"], &[]);
    first.echo(30 * SECOND).unwrap();
    first
        .echo_for(2 * SECOND, Duration::from_millis(200))
        .unwrap();

    // A second process with the same key takes the relay registration.
    let mut second = bed.session(&["--direct"], &[]);
    let second_ok = second.echo(30 * SECOND);
    let first_ok = first.echo_for(10 * SECOND, Duration::from_millis(200));
    eprintln!("direct: second session: {second_ok:?}; first session after: {first_ok:?}");
    assert!(
        second_ok.is_err() || first_ok.is_err(),
        "expected a collision between two direct connects with one key"
    );
}

#[test]
#[ignore = "needs the internet"]
fn two_connects_through_the_agent_do_not_collide() {
    let bed = Bed::with("coll-a", relay_only());
    let mut first = bed.session(&[], &[]);
    first.echo(30 * SECOND).unwrap();
    first
        .echo_for(2 * SECOND, Duration::from_millis(200))
        .unwrap();

    let mut second = bed.session(&[], &[]);
    second.echo(30 * SECOND).unwrap();
    let mut n = 0;
    for _ in 0..50 {
        first.echo(5 * SECOND).unwrap();
        second.echo(5 * SECOND).unwrap();
        n += 2;
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("agent: {n} echoes on two sessions, no miss");
    assert_eq!(bed.agents_started(), 1);
    assert!(first.close().success());
    assert!(second.close().success());
}
