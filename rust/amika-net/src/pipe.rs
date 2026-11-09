//! Byte copying that flushes each write, so interactive SSH traffic is never
//! held in a buffer.

use iroh::endpoint::{RecvStream, SendStream};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Pipes this process's stdin to `send` and `recv` to its stdout.
///
/// The session ends when the remote side ends. Our stdin closing only
/// shuts down `send` (a QUIC finish, or a socket write shutdown); the remote
/// side still sends its final bytes.
pub async fn stdio<W, R>(mut send: W, mut recv: R) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    let mut stdin = io::stdin();
    let mut stdout = io::stdout();
    let to_remote = async {
        let r = copy_flush(&mut stdin, &mut send).await;
        let _ = send.shutdown().await;
        r
    };
    let from_remote = async {
        let r = copy_flush(&mut recv, &mut stdout).await;
        let _ = stdout.flush().await;
        r
    };
    tokio::pin!(to_remote);
    tokio::select! {
        r = from_remote => { r?; }
        r = &mut to_remote => {
            r?;
            copy_flush(&mut recv, &mut stdout).await?;
        }
    }
    Ok(())
}

/// Copies until `r` ends, flushing after each write. Returns the byte count.
pub async fn copy_flush<R, W>(r: &mut R, w: &mut W) -> io::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut total = 0;
    copy_counted(r, w, &mut total).await?;
    Ok(total)
}

/// Copies until `r` ends, flushing after each write, and adds each write's
/// size to `total`, so the count survives an error.
async fn copy_counted<R, W>(r: &mut R, w: &mut W, total: &mut u64) -> io::Result<()>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        w.write_all(&buf[..n]).await?;
        w.flush().await?;
        *total += n as u64;
    }
}

/// What a splice moved, and why it ended.
#[derive(Debug, Default)]
pub struct Spliced {
    /// Bytes from the QUIC stream to the local stream.
    pub to_local: u64,
    /// Bytes from the local stream to the QUIC stream.
    pub to_remote: u64,
    /// The first error in either direction. `None` for a clean end.
    pub error: Option<String>,
}

/// Copies both ways between a local byte stream (a TCP or Unix socket) and a
/// QUIC stream until both directions end. Each side's end of input closes
/// the other side's write half.
pub async fn splice<S>(local: S, mut send: SendStream, mut recv: RecvStream) -> Spliced
where
    S: AsyncRead + AsyncWrite,
{
    let (mut local_r, mut local_w) = io::split(local);
    let mut to_local = 0;
    let mut to_remote = 0;
    let up = async {
        let r = copy_counted(&mut recv, &mut local_w, &mut to_local).await;
        let _ = local_w.shutdown().await;
        r
    };
    let down = async {
        let r = copy_counted(&mut local_r, &mut send, &mut to_remote).await;
        let _ = send.finish();
        r
    };
    let (up, down) = tokio::join!(up, down);
    Spliced {
        to_local,
        to_remote,
        error: up.err().or(down.err()).map(|e| e.to_string()),
    }
}
