//! Byte copying that flushes each write, so interactive SSH traffic is never
//! held in a buffer.

use iroh::endpoint::{RecvStream, SendStream};
use tokio::{
    io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};

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

/// Copies both ways between a TCP socket and a QUIC stream until both
/// directions end. Each side's end of input closes the other side's write
/// half. Returns (bytes to TCP, bytes to QUIC).
pub async fn splice_tcp(tcp: TcpStream, mut send: SendStream, mut recv: RecvStream) -> (u64, u64) {
    let (mut tcp_r, mut tcp_w) = tcp.into_split();
    let up = async {
        let n = copy_flush(&mut recv, &mut tcp_w).await.unwrap_or(0);
        let _ = tcp_w.shutdown().await;
        n
    };
    let down = async {
        let n = copy_flush(&mut tcp_r, &mut send).await.unwrap_or(0);
        let _ = send.finish();
        n
    };
    tokio::join!(up, down)
}
