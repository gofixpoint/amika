/**
 * The counting behind `amika.tunnel.v3`, shared by hostd and the relay.
 *
 * Each side counts the frames it sends and the frames it processes. No frame
 * carries its number: WebSocket delivers in order, so a frame's position is
 * its number. A side keeps the frames the peer has not acknowledged in a
 * `ReplayLog`, and acknowledges what it processed on the schedule
 * `AckSchedule` keeps. After a drop, each side resends from its log what
 * the other did not receive.
 *
 * A **counted frame** is every binary frame but `ACK`. The text keep-alive
 * is not counted.
 *
 * Runs in Node and in a Cloudflare Worker, like the rest of this package.
 */
import { ACK_BYTES, ProtocolError } from "./index.js";

/** Why a log cannot resend from a peer's received count. */
export type ResumeRefusal =
  /** The count is above what was sent, or below what the peer acknowledged. */
  | "count_mismatch"
  /** A frame after the count left the log without an acknowledgement. */
  | "log_truncated";

/**
 * The counted frames this side sent that the peer has not acknowledged.
 *
 * It holds at most `maxBytes`. Past that it drops the oldest frames and
 * records the highest count it dropped, so a later resume that needs one is
 * refused rather than resumed with a gap.
 */
export class ReplayLog {
  /** Held frames, oldest first, from `head`. Taken from the front in O(1). */
  private items: Array<Uint8Array | undefined> = [];
  private head = 0;
  private heldBytes = 0;
  private sentCount: number;
  private ackedCount: number;
  /**
   * Every count at or below this left the log without an acknowledgement:
   * dropped past the limit, or lost with the memory that held it.
   */
  private lostThrough: number;

  /**
   * A fresh log starts at 0. A log `restored` from saved counts holds no
   * frames, so it can resend nothing sent before it was restored: those
   * frames were in memory that is gone.
   */
  constructor(
    private readonly maxBytes: number,
    restored?: { sent: number; acked: number },
  ) {
    this.sentCount = restored?.sent ?? 0;
    this.ackedCount = restored?.acked ?? 0;
    this.lostThrough = this.sentCount;
  }

  /** How many counted frames this side has sent in the session. */
  get sent(): number {
    return this.sentCount;
  }

  /** The highest count the peer has acknowledged. */
  get acked(): number {
    return this.ackedCount;
  }

  /** How many frames the log holds. */
  get frames(): number {
    return this.items.length - this.head;
  }

  /** How many bytes the log holds. */
  get bytes(): number {
    return this.heldBytes;
  }

  /** Count one frame as sent, and keep it until the peer acknowledges it. */
  append(frame: Uint8Array): void {
    this.sentCount += 1;
    this.items.push(frame);
    this.heldBytes += frame.byteLength;
    while (this.heldBytes > this.maxBytes && this.frames > 0) {
      this.lostThrough = this.floor() + 1;
      this.shift();
    }
  }

  /**
   * Apply the peer's `ACK`. The count must be at least the last count
   * acknowledged and at most the sent count. Anything else throws
   * `ProtocolError`: a side never drops a frame on the word of a peer that
   * acknowledges a frame that was never sent.
   */
  acknowledge(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < this.ackedCount ||
      count > this.sentCount
    ) {
      throw new ProtocolError(
        `ACK of ${count} outside ${this.ackedCount} to ${this.sentCount}`,
      );
    }
    this.ackedCount = count;
    while (this.frames > 0 && this.floor() < count) this.shift();
  }

  /**
   * Why the log cannot resend every frame after the peer's received count,
   * or `undefined` when it can.
   */
  refusal(received: number): ResumeRefusal | undefined {
    if (
      !Number.isSafeInteger(received) ||
      received < this.ackedCount ||
      received > this.sentCount
    ) {
      return "count_mismatch";
    }
    if (received < this.lostThrough) return "log_truncated";
    return undefined;
  }

  /**
   * Resume from the peer's received count: take it as an acknowledgement,
   * and return the frames to send again, in order. Throws when `refusal`
   * names a reason; ask it first.
   */
  resume(received: number): Uint8Array[] {
    const refusal = this.refusal(received);
    if (refusal) throw new ProtocolError(`cannot resume: ${refusal}`);
    this.acknowledge(received);
    return this.items.slice(this.head) as Uint8Array[];
  }

  /** The count just below the oldest frame held. */
  private floor(): number {
    return this.sentCount - this.frames;
  }

  private shift(): void {
    const frame = this.items[this.head]!;
    this.items[this.head] = undefined;
    this.head += 1;
    this.heldBytes -= frame.byteLength;
    // Compact now and then, so the array does not grow without bound.
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}

/**
 * When to acknowledge. A side records each counted frame it processes, and
 * sends `ACK` at once after `ackBytes` since its last one, or after a delay
 * that starts at the first frame it has not acknowledged. Timers differ
 * between Node and a Worker, so the caller holds the timer.
 */
export class AckSchedule {
  private processedCount: number;
  private acknowledgedCount: number;
  private pendingBytes = 0;

  constructor(
    private readonly ackBytes: number = ACK_BYTES,
    restored?: { received: number },
  ) {
    this.processedCount = restored?.received ?? 0;
    this.acknowledgedCount = this.processedCount;
  }

  /** How many counted frames this side has processed in the session. */
  get received(): number {
    return this.processedCount;
  }

  /**
   * Record one processed frame of `byteLength` bytes. Returns `"now"` when an
   * `ACK` is due at once, `"arm"` when this is the first frame since the
   * last `ACK` and the delay starts, and `"wait"` otherwise.
   */
  processed(byteLength: number): "now" | "arm" | "wait" {
    const first = this.processedCount === this.acknowledgedCount;
    this.processedCount += 1;
    this.pendingBytes += byteLength;
    if (this.pendingBytes >= this.ackBytes) return "now";
    return first ? "arm" : "wait";
  }

  /**
   * The count to send in an `ACK`, or `undefined` when nothing was processed
   * since the last one. A side with nothing to acknowledge sends nothing.
   */
  take(): number | undefined {
    if (this.processedCount === this.acknowledgedCount) return undefined;
    this.acknowledgedCount = this.processedCount;
    this.pendingBytes = 0;
    return this.acknowledgedCount;
  }

  /**
   * Treat everything processed as acknowledged, and return the count. For a
   * resume handshake, whose received-count header acknowledges it all.
   */
  acknowledgeAll(): number {
    this.take();
    return this.processedCount;
  }
}

/**
 * A count read from a resume header: decimal digits with no sign and no
 * leading zero, at most `Number.MAX_SAFE_INTEGER`. Anything else is
 * `undefined`.
 */
export function parseCount(
  value: string | null | undefined,
): number | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
