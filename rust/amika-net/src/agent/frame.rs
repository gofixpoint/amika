//! Length-prefixed frames: a big-endian `u16` length, then the body.
//!
//! The agent's local protocol uses them. Each caller sets the largest frame
//! it accepts.

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Writes one frame and flushes it. Refuses a body larger than `max`.
pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8], max: usize) -> Result<()> {
    if body.len() > max || body.len() > u16::MAX as usize {
        bail!("frame of {} bytes is too large", body.len());
    }
    let mut buf = Vec::with_capacity(2 + body.len());
    buf.extend_from_slice(&(body.len() as u16).to_be_bytes());
    buf.extend_from_slice(body);
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

/// Reads one frame. Refuses a frame larger than `max`.
pub async fn read<R: AsyncRead + Unpin>(r: &mut R, max: usize) -> Result<Vec<u8>> {
    let len = r.read_u16().await.context("reading frame length")? as usize;
    if len > max {
        bail!("frame of {len} bytes is too large");
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)
        .await
        .context("reading frame body")?;
    Ok(body)
}

/// Splits a frame body into `key value` lines. Empty lines are skipped. A
/// line with no space is a key with an empty value.
pub fn lines(body: &[u8]) -> Result<Vec<(&str, &str)>> {
    let text = std::str::from_utf8(body).context("frame is not UTF-8")?;
    Ok(text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.split_once(' ').unwrap_or((l, "")))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_refuse_oversize() {
        let mut wire = Vec::new();
        write(&mut wire, b"abc", 8).await.unwrap();
        assert_eq!(read(&mut &wire[..], 8).await.unwrap(), b"abc");
        assert!(read(&mut &wire[..], 2).await.is_err());
        assert!(write(&mut Vec::new(), &[0u8; 9], 8).await.is_err());
    }

    #[test]
    fn lines_split_on_the_first_space() {
        assert_eq!(
            lines(b"a 1\n\nb two words\nc\n").unwrap(),
            vec![("a", "1"), ("b", "two words"), ("c", "")]
        );
    }
}
