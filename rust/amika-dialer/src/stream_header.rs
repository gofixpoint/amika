//! The stream header, as the iroh phase 1 contracts fix it
//! (`specs/035-host-connection-drops.d/iroh-contracts.md` in amika-mono,
//! "The stream header"), from the caller's side.
//!
//! Under the ALPN `amika/net/1`, each stream starts with one line per
//! part and an empty line:
//!
//! ```text
//! version 1
//! target hostd
//!
//! ```
//!
//! The host answers one line, `ok` or `refused <reason>`. After `ok` the
//! stream carries raw bytes both ways.
//!
//! `amika-net` holds the host's side of this. The dialer needs only the
//! caller's side, and `amika-net` has no library target yet, so the
//! dialer keeps its own copy.

use std::fmt;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The ALPN of every `amika-net` connection.
pub const ALPN: &[u8] = b"amika/net/1";

/// The longest status line the dialer reads, newline included.
const MAX_STATUS_LINE: usize = 1024;

/// The target that serves hostd's own HTTP listener.
pub const HOSTD_TARGET: &str = "hostd";

/// Why a host refused a stream. The contract fixes the first four; the
/// dialer keeps any other word as it came, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NotAllowed,
    UnknownRig,
    PortNotAllowed,
    Unreachable,
    Other(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::NotAllowed => f.write_str("not_allowed"),
            Refusal::UnknownRig => f.write_str("unknown_rig"),
            Refusal::PortNotAllowed => f.write_str("port_not_allowed"),
            Refusal::Unreachable => f.write_str("unreachable"),
            Refusal::Other(s) => f.write_str(s),
        }
    }
}

/// The host's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Ok,
    Refused(Refusal),
}

/// The bytes that open a stream to `target`.
pub fn encode_request(target: &str) -> Vec<u8> {
    format!("version 1\ntarget {target}\n\n").into_bytes()
}

/// Sends the header for `target`.
pub async fn write_request<W: AsyncWrite + Unpin>(w: &mut W, target: &str) -> Result<()> {
    w.write_all(&encode_request(target)).await?;
    w.flush().await?;
    Ok(())
}

/// Reads the host's status line, and nothing after it: the bytes that
/// follow `ok` belong to the target.
pub async fn read_status<R: AsyncRead + Unpin>(r: &mut R) -> Result<Status> {
    let line = read_line(r).await?;
    parse_status(&line)
}

fn parse_status(line: &str) -> Result<Status> {
    if line == "ok" {
        return Ok(Status::Ok);
    }
    let Some(reason) = line.strip_prefix("refused ") else {
        bail!("unknown status {line:?}");
    };
    let reason = reason.trim();
    Ok(Status::Refused(match reason {
        "not_allowed" => Refusal::NotAllowed,
        "unknown_rig" => Refusal::UnknownRig,
        "port_not_allowed" => Refusal::PortNotAllowed,
        "unreachable" => Refusal::Unreachable,
        other => Refusal::Other(other.to_string()),
    }))
}

/// Reads one line, one byte at a time, so no byte after the newline is
/// taken from the stream. The line is a few bytes, once per stream.
async fn read_line<R: AsyncRead + Unpin>(r: &mut R) -> Result<String> {
    let mut line = Vec::new();
    loop {
        let b = r.read_u8().await.context("reading the status line")?;
        if b == b'\n' {
            break;
        }
        line.push(b);
        if line.len() >= MAX_STATUS_LINE {
            bail!("status line is longer than {MAX_STATUS_LINE} bytes");
        }
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line).context("status line is not UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_is_two_lines_and_an_empty_line() {
        assert_eq!(encode_request("hostd"), b"version 1\ntarget hostd\n\n");
    }

    #[tokio::test]
    async fn status_lines_parse_and_leave_the_payload() {
        let mut wire: &[u8] = b"ok\nHTTP/1.1 200 OK\r\n";
        assert_eq!(read_status(&mut wire).await.unwrap(), Status::Ok);
        assert_eq!(wire, b"HTTP/1.1 200 OK\r\n");
        for (line, want) in [
            ("refused not_allowed\n", Refusal::NotAllowed),
            ("refused unknown_rig\n", Refusal::UnknownRig),
            ("refused port_not_allowed\n", Refusal::PortNotAllowed),
            ("refused unreachable\n", Refusal::Unreachable),
            (
                "refused later_reason\n",
                Refusal::Other("later_reason".into()),
            ),
        ] {
            let mut r = line.as_bytes();
            assert_eq!(read_status(&mut r).await.unwrap(), Status::Refused(want));
        }
        assert!(read_status(&mut &b"nope\n"[..]).await.is_err());
        assert!(read_status(&mut &b"ok"[..]).await.is_err());
        assert!(read_status(&mut &[b'a'; 2000][..]).await.is_err());
    }
}
