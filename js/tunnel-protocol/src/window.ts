/**
 * Credit for `DATA`, one per stream and direction.
 *
 * The sender holds a `SendWindow` and the receiver a `ReceiveWindow`. Both
 * start at `INITIAL_WINDOW`. The receiver grants credit back with `WINDOW`
 * only once it has handed the bytes on, so a sender can never get further
 * ahead of the far end's consumer than one window.
 */
import { INITIAL_WINDOW } from "./index.js";

/** How much this side may still send. */
export class SendWindow {
  private credit = INITIAL_WINDOW;
  private waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private failure?: Error;

  /** The far end granted `credit` more bytes. */
  grant(credit: number): void {
    this.credit += credit;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /**
   * Wait for credit, and take up to `wanted` bytes of it. Resolves with how
   * many bytes were taken, which is at least one. Rejects once the window is
   * closed.
   */
  async take(wanted: number): Promise<number> {
    while (this.credit <= 0) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
    }
    if (this.failure) throw this.failure;
    const taken = Math.min(wanted, this.credit);
    this.credit -= taken;
    return taken;
  }

  /** The stream is gone. Every wait rejects with `error`. */
  close(error: Error): void {
    this.failure ??= error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
}

/** How much the far end may still send this side. */
export class ReceiveWindow {
  private remaining = INITIAL_WINDOW;

  /**
   * Account for `bytes` that arrived. Returns false when the sender went
   * past its credit, which is a protocol error that resets the stream.
   */
  receive(bytes: number): boolean {
    if (bytes > this.remaining) return false;
    this.remaining -= bytes;
    return true;
  }

  /**
   * `bytes` were handed on. Returns the credit to grant back with `WINDOW`,
   * or 0 when there is none to send.
   */
  release(bytes: number): number {
    this.remaining += bytes;
    return bytes;
  }
}
