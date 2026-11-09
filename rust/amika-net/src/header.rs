//! The stream header, under the ALPN `amika/net/1`.
//!
//! Each QUIC stream starts with a header from the caller, one part per
//! line, ended by an empty line:
//!
//! ```text
//! version 1
//! target rig:<rig id>:<port>
//!
//! ```
//!
//! The host answers one line: `ok`, or `refused <reason>`. After `ok`, the
//! stream carries raw bytes in both directions until either side finishes.
//!
//! Both sides read the header one byte at a time, so no byte after it is
//! read early. The target (an SSH server, say) may send first, right after
//! `ok`.

use std::{fmt, str::FromStr};

use anyhow::{Context, Result, anyhow, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The ALPN of every amika-net connection.
pub const ALPN: &[u8] = b"amika/net/1";

/// The header version this build speaks.
pub const VERSION: u32 = 1;

/// The largest header either side accepts, in bytes.
const MAX_HEADER: usize = 1024;

/// What a stream connects to on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// hostd's own HTTP listener.
    Hostd,
    /// A TCP port on a rig.
    Rig { id: String, port: u16 },
}

impl FromStr for Target {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        if s == "hostd" {
            return Ok(Target::Hostd);
        }
        let rest = s
            .strip_prefix("rig:")
            .ok_or_else(|| anyhow!("unknown target {s:?}"))?;
        let (id, port) = rest
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("rig target {s:?} has no port"))?;
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            bail!("rig id {id:?} is not valid");
        }
        let port = port.parse().with_context(|| format!("bad port in {s:?}"))?;
        Ok(Target::Rig {
            id: id.to_string(),
            port,
        })
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Target::Hostd => write!(f, "hostd"),
            Target::Rig { id, port } => write!(f, "rig:{id}:{port}"),
        }
    }
}

/// Why a host refused a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The rules do not let the caller reach the target.
    NotAllowed,
    /// The host has no such rig.
    UnknownRig,
    /// The rig does not expose the port.
    PortNotAllowed,
    /// The host cannot reach the target now.
    Unreachable,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NotAllowed => "not_allowed",
            Refusal::UnknownRig => "unknown_rig",
            Refusal::PortNotAllowed => "port_not_allowed",
            Refusal::Unreachable => "unreachable",
        }
    }
}

impl FromStr for Refusal {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        [
            Refusal::NotAllowed,
            Refusal::UnknownRig,
            Refusal::PortNotAllowed,
            Refusal::Unreachable,
        ]
        .into_iter()
        .find(|r| r.as_str() == s)
        .ok_or_else(|| anyhow!("unknown refusal reason {s:?}"))
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The host's answer to a header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Refused(Refusal),
}

/// Writes the header for `target`.
pub async fn write_request<W: AsyncWrite + Unpin>(w: &mut W, target: &Target) -> Result<()> {
    write_all(w, encode_request(target).as_bytes()).await
}

/// Reads a header, and returns its target. Fails on a header that is too
/// large, has another version, or has no valid target.
pub async fn read_request<R: AsyncRead + Unpin>(r: &mut R) -> Result<Target> {
    let mut lines = Vec::new();
    let mut budget = MAX_HEADER;
    loop {
        let line = read_line(r, &mut budget).await?;
        if line.is_empty() {
            break;
        }
        lines.push(line);
    }
    parse_request(&lines)
}

/// Writes the host's answer.
pub async fn write_status<W: AsyncWrite + Unpin>(w: &mut W, status: Status) -> Result<()> {
    write_all(w, encode_status(status).as_bytes()).await
}

/// Reads the host's answer.
pub async fn read_status<R: AsyncRead + Unpin>(r: &mut R) -> Result<Status> {
    let mut budget = MAX_HEADER;
    parse_status(&read_line(r, &mut budget).await?)
}

fn encode_request(target: &Target) -> String {
    format!("version {VERSION}\ntarget {target}\n\n")
}

/// Parses the header lines. Unknown parts are ignored, so a newer caller
/// can add optional parts.
fn parse_request(lines: &[String]) -> Result<Target> {
    let mut version = None;
    let mut target = None;
    for line in lines {
        let (key, value) = line
            .split_once(' ')
            .ok_or_else(|| anyhow!("header line {line:?} has no value"))?;
        match key {
            "version" => version = Some(value.parse::<u32>().context("bad version")?),
            "target" => target = Some(value.parse::<Target>()?),
            _ => {}
        }
    }
    match version {
        Some(VERSION) => {}
        Some(v) => bail!("unsupported header version {v}"),
        None => bail!("header has no version"),
    }
    target.ok_or_else(|| anyhow!("header has no target"))
}

fn encode_status(status: Status) -> String {
    match status {
        Status::Ok => "ok\n".to_string(),
        Status::Refused(reason) => format!("refused {reason}\n"),
    }
}

fn parse_status(line: &str) -> Result<Status> {
    if line == "ok" {
        return Ok(Status::Ok);
    }
    let reason = line
        .strip_prefix("refused ")
        .ok_or_else(|| anyhow!("unknown status {line:?}"))?;
    Ok(Status::Refused(reason.parse()?))
}

/// Reads one line, without its newline, one byte at a time. Takes the bytes
/// it reads from `budget`, and fails when the budget runs out.
async fn read_line<R: AsyncRead + Unpin>(r: &mut R, budget: &mut usize) -> Result<String> {
    let mut line = Vec::new();
    loop {
        if *budget == 0 {
            bail!("header is larger than {MAX_HEADER} bytes");
        }
        *budget -= 1;
        let byte = r.read_u8().await.context("reading the header")?;
        if byte == b'\n' {
            break;
        }
        line.push(byte);
    }
    String::from_utf8(line).context("header is not UTF-8")
}

async fn write_all<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> Result<()> {
    w.write_all(bytes).await?;
    w.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_round_trip() {
        for s in ["hostd", "rig:abc-1:22", "rig:x_y:65535"] {
            assert_eq!(s.parse::<Target>().unwrap().to_string(), s);
        }
    }

    #[test]
    fn bad_targets_are_refused() {
        for s in [
            "",
            "echo",
            "rig:",
            "rig:abc",
            "rig::22",
            "rig:a b:22",
            "rig:a:99999",
            "host:x:1",
        ] {
            assert!(s.parse::<Target>().is_err(), "{s:?} parsed");
        }
    }

    #[tokio::test]
    async fn the_header_is_lines_ended_by_an_empty_line() {
        let target = Target::Rig {
            id: "r1".into(),
            port: 22,
        };
        let mut wire = Vec::new();
        write_request(&mut wire, &target).await.unwrap();
        assert_eq!(wire, b"version 1\ntarget rig:r1:22\n\n");
    }

    #[tokio::test]
    async fn a_header_leaves_the_bytes_after_it_unread() {
        let mut r: &[u8] = b"version 1\ntarget hostd\n\npayload";
        assert_eq!(read_request(&mut r).await.unwrap(), Target::Hostd);
        assert_eq!(r, b"payload");
    }

    #[tokio::test]
    async fn a_header_needs_a_known_version_and_a_target() {
        async fn read(bytes: &[u8]) -> Result<Target> {
            read_request(&mut &bytes[..]).await
        }
        assert!(read(b"version 2\ntarget hostd\n\n").await.is_err());
        assert!(read(b"target hostd\n\n").await.is_err());
        assert!(read(b"version 1\n\n").await.is_err());
        assert!(read(b"version 1\ntarget hostd\n").await.is_err(), "no end");
        assert_eq!(
            read(b"version 1\nfuture x\ntarget hostd\n\n")
                .await
                .unwrap(),
            Target::Hostd
        );
    }

    #[tokio::test]
    async fn an_oversized_header_is_refused() {
        let mut wire = b"version 1\nx ".to_vec();
        wire.extend(std::iter::repeat_n(b'a', MAX_HEADER));
        wire.extend_from_slice(b"\ntarget hostd\n\n");
        assert!(read_request(&mut &wire[..]).await.is_err());
    }

    #[tokio::test]
    async fn statuses_round_trip_and_leave_the_payload_unread() {
        for (status, line) in [
            (Status::Ok, "ok\n"),
            (
                Status::Refused(Refusal::PortNotAllowed),
                "refused port_not_allowed\n",
            ),
            (
                Status::Refused(Refusal::NotAllowed),
                "refused not_allowed\n",
            ),
            (
                Status::Refused(Refusal::UnknownRig),
                "refused unknown_rig\n",
            ),
            (
                Status::Refused(Refusal::Unreachable),
                "refused unreachable\n",
            ),
        ] {
            let mut wire = Vec::new();
            write_status(&mut wire, status).await.unwrap();
            assert_eq!(wire, line.as_bytes());
            wire.extend_from_slice(b"SSH-2.0");
            let mut r = &wire[..];
            assert_eq!(read_status(&mut r).await.unwrap(), status);
            assert_eq!(r, b"SSH-2.0");
        }
        assert!(read_status(&mut &b"refused nope\n"[..]).await.is_err());
        assert!(read_status(&mut &b"maybe\n"[..]).await.is_err());
    }
}
