//! amika-net: SSH and TCP streams to Amika hosts over iroh.
//!
//! The `amika-net` binary is a thin layer over this library. Other crates
//! (the dialer, for one) use the library for the same wire format and
//! endpoint setup:
//!
//! - [`header`]: the ALPN, the stream header (`version 1`, `target ...`,
//!   an empty line), the target type, and the `ok` or `refused <reason>`
//!   answer.
//! - [`net`]: the endpoint builder: relay choice, relay URLs, the n0 Pro
//!   relay token, QUIC settings, and address lookup off.
//! - [`keys`]: key files and the host key on a file descriptor.
//! - [`connect`]: dial a host by endpoint id and relay URL, and open a
//!   stream to a target.
//!
//! The roles:
//! - [`host`] runs beside hostd. It accepts QUIC streams from allowed
//!   callers and forwards each to the target that hostd names.
//! - [`connect`] is the SSH `ProxyCommand` on a caller. It goes through the
//!   per-user [`agent`], which holds the device key.

#[cfg(unix)]
pub mod agent;
pub mod connect;
pub mod header;
#[cfg(unix)]
pub mod host;
pub mod keys;
pub mod net;
pub mod paths;
pub mod pipe;

pub use header::{ALPN, Refusal, Status, Target};

/// This build's version. A release sets `AMIKA_NET_VERSION` at build time.
pub const VERSION: &str = match option_env!("AMIKA_NET_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};
