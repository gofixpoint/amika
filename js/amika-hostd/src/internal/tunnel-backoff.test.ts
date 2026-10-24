import { describe, expect, it } from "vitest";
import { Backoff, DEFAULT_BACKOFF } from "./tunnel-backoff.js";

/** A schedule with the jitter pinned, so the window itself is visible. */
function schedule(random: () => number, overrides = {}) {
  return new Backoff({
    minDelayMs: 500,
    initialDelayMs: 1_000,
    maxDelayMs: 8_000,
    multiplier: 2,
    resetAfterMs: 60_000,
    random,
    ...overrides,
  });
}

describe("the window", () => {
  it("doubles with each failure and then stops at the cap", () => {
    const backoff = schedule(() => 1);

    const windows = Array.from({ length: 6 }, () => backoff.nextDelayMs());

    expect(windows).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("never waits less than the floor, however the draw falls", () => {
    const backoff = schedule(() => 0);

    expect([backoff.nextDelayMs(), backoff.nextDelayMs()]).toEqual([500, 500]);
  });

  it("draws across the whole window rather than nudging it", () => {
    // The point of the jitter is that a fleet dropped by one gateway deploy
    // does not come back in step. A scheme that varies the wait by a few
    // percent would pass a test that only checked "not always equal", so
    // this checks the spread covers most of the window.
    const backoff = schedule(Math.random);
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    // The window here is 8s with a 500ms floor, so draws live in [500, 8000].
    const draws = Array.from({ length: 500 }, () => {
      const value = backoff.nextDelayMs();
      backoff.reset();
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      return value;
    });

    expect(Math.min(...draws)).toBeLessThan(1_500);
    expect(Math.max(...draws)).toBeGreaterThan(7_000);
  });
});

describe("a session that worked", () => {
  it("starts the schedule again", () => {
    // A laptop that sleeps nightly would otherwise bring yesterday's cap to
    // this morning's first reconnect.
    const backoff = schedule(() => 1);
    backoff.nextDelayMs();
    backoff.nextDelayMs();

    backoff.recordSession(120_000);

    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("does not, when it barely lasted", () => {
    const backoff = schedule(() => 1);
    backoff.nextDelayMs();

    backoff.recordSession(900);

    expect(backoff.nextDelayMs()).toBe(2_000);
  });
});

describe("a schedule that cannot space anything out", () => {
  it.each([
    ["a floor above the first window", { minDelayMs: 2_000 }],
    ["a cap below the first window", { maxDelayMs: 100 }],
    ["a multiplier below one", { multiplier: 0.5 }],
    ["a delay that is not a number", { initialDelayMs: Number.NaN }],
    ["a cap with no end", { maxDelayMs: Number.POSITIVE_INFINITY }],
  ])("is refused: %s", (_name, overrides) => {
    expect(() => schedule(() => 1, overrides)).toThrow(RangeError);
  });
});

describe("the shipped schedule", () => {
  it("is ordered, so the daemon starts", () => {
    expect(() => new Backoff(DEFAULT_BACKOFF)).not.toThrow();
  });

  it("brings a host back inside a minute on the worst draw", () => {
    // A host that is waiting is a host its users cannot reach, so the cap
    // is a product decision and not only a safety valve.
    expect(DEFAULT_BACKOFF.maxDelayMs).toBeLessThanOrEqual(60_000);
  });
});
