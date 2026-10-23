/**
 * How long to wait before dialling the gateway again.
 *
 * Three things have to be true at once, and each one rules out a simpler
 * scheme.
 *
 * **It must back off.** A gateway that is down, or a credential that is
 * revoked, must not be retried as fast as the event loop turns. The window
 * therefore grows by `multiplier` each attempt, up to `maxDelayMs`.
 *
 * **It must not synchronise a fleet.** A gateway deploy drops every host at
 * the same instant. Hosts that all wait the same growing interval arrive
 * together, knock the gateway over again, and stay in step for as long as
 * the outage lasts. So the wait is drawn uniformly from the whole window
 * (AWS calls this "full jitter"), not jittered by a few percent around it.
 * Equal jitter -- half the window plus a random half -- spreads a fleet
 * across only half as much time for the same mean wait, and the extra
 * spread is the entire point.
 *
 * **It must not collapse to zero.** Full jitter can draw a wait of one
 * millisecond, and the failure that most often repeats immediately is a
 * gateway that completes the WebSocket handshake and then drops the
 * connection, which is what a refused attachment looks like from here. So
 * every wait has a floor of `minDelayMs`, and the jitter covers the window
 * above it.
 *
 * `recordSession` is the fourth piece, and it matters on a laptop. A machine
 * that sleeps every night reconnects every morning, and without it each
 * morning's first attempt would inherit the cap reached the night before. A
 * session that stayed up for `resetAfterMs` means the last disconnect was an
 * event and not a pattern, so the schedule starts again.
 */
export interface BackoffOptions {
  /** The floor under every wait. */
  minDelayMs: number;
  /** The first window's upper edge. */
  initialDelayMs: number;
  /** The largest window, however many attempts have failed. */
  maxDelayMs: number;
  /** How fast the window grows. */
  multiplier: number;
  /** A session that lasted at least this long resets the schedule. */
  resetAfterMs: number;
  /** Injected in tests; `Math.random` otherwise. */
  random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  // Long enough that a gateway refusing attachments is not a hot loop, short
  // enough that an operator restarting a gateway does not notice.
  minDelayMs: 500,
  initialDelayMs: 2_000,
  // A laptop coming out of sleep should be back within a minute even on the
  // unluckiest draw. Beyond that the host is offline to its users anyway,
  // and the control plane already reports it so.
  maxDelayMs: 60_000,
  multiplier: 2,
  // Longer than a handshake plus an authorization round trip, so a session
  // that was refused never counts as one that worked.
  resetAfterMs: 60_000,
};

export class Backoff {
  private readonly options: Required<BackoffOptions>;
  private failures = 0;

  constructor(options: BackoffOptions) {
    requireOrdered(options);
    this.options = { random: Math.random, ...options };
  }

  /** How many waits have been handed out since the last reset. */
  get attempts(): number {
    return this.failures;
  }

  /** The next wait, in milliseconds, advancing the schedule. */
  nextDelayMs(): number {
    const { minDelayMs, initialDelayMs, maxDelayMs, multiplier, random } =
      this.options;
    const window = Math.min(
      maxDelayMs,
      initialDelayMs * multiplier ** this.failures,
    );
    this.failures += 1;
    // `window` is never below `minDelayMs`: `requireOrdered` checks the
    // initial window, and the window only grows from there.
    return minDelayMs + random() * (window - minDelayMs);
  }

  /**
   * Record how long a session lasted, and start the schedule again if it
   * lasted long enough to count as working.
   */
  recordSession(durationMs: number): void {
    if (durationMs >= this.options.resetAfterMs) this.reset();
  }

  reset(): void {
    this.failures = 0;
  }
}

/**
 * Refuse a schedule that cannot space anything out.
 *
 * Each of these produces a hot loop or a wait that never ends, and both look
 * like the daemon working until someone reads a graph. A non-finite value is
 * the worst of them: `NaN` makes every comparison false, so a cap written as
 * `Math.min` lets it through and the wait that comes out schedules nothing.
 */
function requireOrdered(options: BackoffOptions): void {
  const finite = (name: keyof BackoffOptions, value: number) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `${name} must be a finite duration of zero or more, not ${value}`,
      );
    }
  };
  finite("minDelayMs", options.minDelayMs);
  finite("initialDelayMs", options.initialDelayMs);
  finite("maxDelayMs", options.maxDelayMs);
  finite("resetAfterMs", options.resetAfterMs);
  if (!Number.isFinite(options.multiplier) || options.multiplier < 1) {
    throw new RangeError(
      `multiplier must be a finite number of one or more, not ${options.multiplier}`,
    );
  }
  if (options.initialDelayMs < options.minDelayMs) {
    throw new RangeError(
      `initialDelayMs (${options.initialDelayMs}) must be at least minDelayMs (${options.minDelayMs})`,
    );
  }
  if (options.maxDelayMs < options.initialDelayMs) {
    throw new RangeError(
      `maxDelayMs (${options.maxDelayMs}) must be at least initialDelayMs (${options.initialDelayMs})`,
    );
  }
}
