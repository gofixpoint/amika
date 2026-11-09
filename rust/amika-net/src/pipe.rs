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
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Ok(total);
        }
        w.write_all(&buf[..n]).await?;
        w.flush().await?;
        total += n as u64;
    }
}

/// Copies both ways between a local byte stream (a TCP or Unix socket) and a
/// QUIC stream until both directions end. Each side's end of input closes
/// the other side's write half. Returns (bytes to local, bytes to QUIC).
pub async fn splice<S>(local: S, mut send: SendStream, mut recv: RecvStream) -> (u64, u64)
where
    S: AsyncRead + AsyncWrite,
{
    let (mut local_r, mut local_w) = io::split(local);
    let up = async {
        let n = copy_flush(&mut recv, &mut local_w).await.unwrap_or(0);
        let _ = local_w.shutdown().await;
        n
    };
    let down = async {
        let n = copy_flush(&mut local_r, &mut send).await.unwrap_or(0);
        let _ = send.finish();
        n
    };
    tokio::join!(up, down)
}
