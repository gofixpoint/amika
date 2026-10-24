/**
 * Limits an incoming yamux DATA frame before the decoder accumulates it.
 *
 * `@libp2p/yamux` checks a stream's receive window only after it has decoded
 * a whole DATA frame. A peer can declare a large length and then send the
 * payload slowly; the decoder holds every byte it has received, far past the
 * window that was meant to bound it. A limit on WebSocket message size does
 * not help, because a yamux frame can span several messages and each message
 * is within the limit.
 *
 * This class reads the 12-byte header as the bytes arrive and refuses a
 * declared length this connection may not send. That is a length check and
 * nothing more. It is not a second multiplexer and not a complete validator
 * for hostile frames.
 *
 * The gateway runs the same guard on its side, for the same defect. Here the
 * peer is Amika's own gateway rather than a tenant's host, so this bounds the
 * damage a compromised or faulty gateway can do to one operator's machine --
 * the daemon runs on someone's laptop, and an unbounded decoder buffer there
 * is their memory.
 */
export class YamuxFrameGuard {
  private readonly header = Buffer.alloc(HEADER_BYTES);
  private headerBytes = 0;
  private remainingData = 0;

  constructor(private readonly maxDataBytes: number) {}

  /**
   * Read the next bytes off the wire, throwing on a frame this connection
   * may not send. Call it with every chunk, in order, before the decoder
   * sees them.
   */
  consume(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      // Inside a payload whose header already passed: skip to its end.
      if (this.remainingData > 0) {
        const consumed = Math.min(
          this.remainingData,
          chunk.byteLength - offset,
        );
        offset += consumed;
        this.remainingData -= consumed;
        continue;
      }
      // Headers arrive split as readily as payloads do, so fill across
      // chunks rather than assuming one lands whole.
      const take = Math.min(
        HEADER_BYTES - this.headerBytes,
        chunk.byteLength - offset,
      );
      this.header.set(chunk.subarray(offset, offset + take), this.headerBytes);
      this.headerBytes += take;
      offset += take;
      if (this.headerBytes !== HEADER_BYTES) continue;
      this.headerBytes = 0;
      this.checkHeader();
    }
  }

  private checkHeader(): void {
    if (this.header[0] !== YAMUX_VERSION) {
      throw new Error("Unsupported yamux version");
    }
    const type = this.header[1]!;
    if (type > MAX_FRAME_TYPE) throw new Error("Unknown yamux frame type");
    // Only DATA carries a payload. The length field of every other type is a
    // window delta, a ping value or a go-away reason, none of which is
    // followed by bytes to skip.
    if (type !== FRAME_TYPE_DATA) return;
    const length = this.header.readUInt32BE(LENGTH_OFFSET);
    if (length > this.maxDataBytes) {
      throw new Error(
        `Yamux DATA frame declares ${length} bytes, over the ${this.maxDataBytes} allowed`,
      );
    }
    this.remainingData = length;
  }
}

const HEADER_BYTES = 12;
const LENGTH_OFFSET = 8;
const YAMUX_VERSION = 0;
const FRAME_TYPE_DATA = 0;
/** DATA, WINDOW_UPDATE, PING, GO_AWAY. */
const MAX_FRAME_TYPE = 3;
