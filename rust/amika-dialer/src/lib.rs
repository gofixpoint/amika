//! amika-dialer: serves amika.run requests for hosts on the iroh transport.
//!
//! The reverse proxy forwards a request for a rig on an iroh host here,
//! with the signed headers it sends the gateway. The dialer checks them,
//! opens a stream to the host's `hostd` target over iroh, and sends the
//! request over it. See `specs/035-host-connection-drops.d/iroh-transport.md`
//! in amika-mono, "The dialer".

pub mod config;
pub mod endpoint;
pub mod forward;
pub mod pool;
pub mod server;
pub mod stream_header;
pub mod token;
