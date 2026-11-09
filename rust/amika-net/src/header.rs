//! The stream header: the first frame on each QUIC stream names a target,
//! and the host answers with one status frame.
//!
//! A frame is a big-endian `u16` length and a UTF-8 body. The request body
//! is `version 1\ntarget <target>\n`. The status body is `ok`, or
//! `error <reason>: <detail>`. After `ok`, the stream carries raw bytes.

use std::{fmt, str::FromStr};

use anyhow::{Context, Result, anyhow, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The ALPN that every amika-net connection uses.
pub const ALPN: &[u8] = b"amika/net/1";

/// The header version this build speaks.
pub const VERSION: u32 = 1;

/// The largest header frame either side accepts.
const MAX_FRAME: usize = 1024;

/// What a stream connects to on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// hostd's own HTTP listener.
    Hostd,
    /// A TCP port on a rig.
    Rig { id: String, port: u16 },
    /// A spike-only echo service, for RTT probes without a TCP target.
    Echo,
}

impl FromStr for Target {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "hostd" => return Ok(Target::Hostd),
            "echo" => return Ok(Target::Echo),
            _ => {}
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
            Target::Echo => write!(f, "echo"),
            Target::Rig { id, port } => write!(f, "rig:{id}:{port}"),
        }
    }
}

/// Why a host refused a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotAllowed,
    UnknownRig,
    PortNotAllowed,
    Unreachable,
    BadHeader,
}

impl Refusal {
    fn as_str(self) -> &'static str {
        match self {
            Refusal::NotAllowed => "not-allowed",
            Refusal::UnknownRig => "unknown-rig",
            Refusal::PortNotAllowed => "port-not-allowed",
            Refusal::Unreachable => "unreachable",
            Refusal::BadHeader => "bad-header",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [
            Refusal::NotAllowed,
            Refusal::UnknownRig,
            Refusal::PortNotAllowed,
            Refusal::Unreachable,
            Refusal::BadHeader,
        ]
        .into_iter()
        .find(|r| r.as_str() == s)
    }
}

/// The host's answer to a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Ok,
    Refused { reason: Refusal, detail: String },
}

pub async fn write_request<W: AsyncWrite + Unpin>(w: &mut W, target: &Target) -> Result<()> {
    write_frame(w, encode_request(target).as_bytes()).await
}

pub async fn read_request<R: AsyncRead + Unpin>(r: &mut R) -> Result<Target> {
    let body = read_frame(r).await?;
    parse_request(&body)
}

pub async fn write_status<W: AsyncWrite + Unpin>(w: &mut W, status: &Status) -> Result<()> {
    write_frame(w, encode_status(status).as_bytes()).await
}

pub async fn read_status<R: AsyncRead + Unpin>(r: &mut R) -> Result<Status> {
    let body = read_frame(r).await?;
    parse_status(&body)
}

fn encode_request(target: &Target) -> String {
    format!("version {VERSION}\ntarget {target}\n")
}

fn parse_request(body: &[u8]) -> Result<Target> {
    let text = std::str::from_utf8(body).context("header is not UTF-8")?;
    let mut version = None;
    let mut target = None;
    for line in text.lines().filter(|l| !l.is_empty()) {
        let (key, value) = line
            .split_once(' ')
            .ok_or_else(|| anyhow!("header line {line:?} has no value"))?;
        match key {
            "version" => version = Some(value.parse::<u32>().context("bad version")?),
            "target" => target = Some(value.parse::<Target>()?),
            // Unknown keys are ignored so a newer caller can add optional fields.
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

fn encode_status(status: &Status) -> String {
    match status {
        Status::Ok => "ok".to_string(),
        Status::Refused { reason, detail } => format!("error {}: {detail}", reason.as_str()),
    }
}

fn parse_status(body: &[u8]) -> Result<Status> {
    let text = std::str::from_utf8(body).context("status is not UTF-8")?;
    if text == "ok" {
        return Ok(Status::Ok);
    }
    let rest = text
        .strip_prefix("error ")
        .ok_or_else(|| anyhow!("unknown status {text:?}"))?;
    let (reason, detail) = rest.split_once(": ").unwrap_or((rest, ""));
    let reason = Refusal::parse(reason).ok_or_else(|| anyhow!("unknown refusal {reason:?}"))?;
    Ok(Status::Refused {
        reason,
        detail: detail.to_string(),
    })
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8]) -> Result<()> {
    if body.len() > MAX_FRAME {
        bail!("frame of {} bytes is too large", body.len());
    }
    let mut buf = Vec::with_capacity(2 + body.len());
    buf.extend_from_slice(&(body.len() as u16).to_be_bytes());
    buf.extend_from_slice(body);
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>> {
    let len = r.read_u16().await.context("reading frame length")? as usize;
    if len > MAX_FRAME {
        bail!("frame of {len} bytes is too large");
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)
        .await
        .context("reading frame body")?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_round_trip() {
        for s in ["hostd", "echo", "rig:abc-1:22", "rig:x_y:65535"] {
            assert_eq!(s.parse::<Target>().unwrap().to_string(), s);
        }
    }

    #[test]
    fn bad_targets_are_refused() {
        for s in [
            "",
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

    #[test]
    fn request_needs_known_version_and_target() {
        let target = Target::Rig {
            id: "r1".into(),
            port: 22,
        };
        assert_eq!(
            parse_request(encode_request(&target).as_bytes()).unwrap(),
            target
        );
        assert!(parse_request(b"version 2\ntarget hostd\n").is_err());
        assert!(parse_request(b"target hostd\n").is_err());
        assert!(parse_request(b"version 1\n").is_err());
        assert_eq!(
            parse_request(b"version 1\nfuture-field x\ntarget hostd\n").unwrap(),
            Target::Hostd
        );
    }

    #[test]
    fn status_round_trips() {
        let refused = Status::Refused {
            reason: Refusal::PortNotAllowed,
            detail: "port 80".into(),
        };
        for s in [Status::Ok, refused] {
            assert_eq!(parse_status(encode_status(&s).as_bytes()).unwrap(), s);
        }
    }

    #[tokio::test]
    async fn frames_round_trip_and_leave_payload_unread() {
        let mut wire = Vec::new();
        write_request(&mut wire, &Target::Echo).await.unwrap();
        wire.extend_from_slice(b"payload");
        let mut r = &wire[..];
        assert_eq!(read_request(&mut r).await.unwrap(), Target::Echo);
        assert_eq!(r, b"payload");
    }

    #[tokio::test]
    async fn oversized_frames_are_refused() {
        let mut wire = vec![0xff, 0xff];
        wire.extend(std::iter::repeat_n(b'a', 10));
        assert!(read_frame(&mut &wire[..]).await.is_err());
    }
}
