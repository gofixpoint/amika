import { describe, expect, it } from "vitest";
import { ProtocolError } from "./index.js";
import { AckSchedule, parseCount, ReplayLog } from "./resume.js";

/** A frame whose bytes say which count it was sent as. */
function frame(count: number, size = 4): Uint8Array {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, count);
  return bytes;
}

function countsOf(frames: Uint8Array[]): number[] {
  return frames.map((bytes) => new DataView(bytes.buffer).getUint32(0));
}

/** A log with frames 1 to `sent` appended. */
function logWith(sent: number, maxBytes = 1024): ReplayLog {
  const log = new ReplayLog(maxBytes);
  for (let count = 1; count <= sent; count += 1) log.append(frame(count));
  return log;
}

describe("the replay log", () => {
  it("counts what it sends and holds what is not acknowledged", () => {
    const log = logWith(5);
    expect(log.sent).toBe(5);
    expect(log.frames).toBe(5);
    expect(log.bytes).toBe(20);
    log.acknowledge(3);
    expect(log.acked).toBe(3);
    expect(log.frames).toBe(2);
    expect(log.bytes).toBe(8);
    log.acknowledge(5);
    expect(log.frames).toBe(0);
    expect(log.bytes).toBe(0);
  });

  it("accepts the same ACK twice", () => {
    const log = logWith(4);
    log.acknowledge(2);
    log.acknowledge(2);
    expect(log.frames).toBe(2);
  });

  it.each([
    ["above the sent count", 6],
    ["below the last ACK", 1],
    ["negative", -1],
    ["not a whole number", 2.5],
  ])("refuses an ACK %s", (_name, count) => {
    const log = logWith(5);
    log.acknowledge(2);
    expect(() => log.acknowledge(count)).toThrow(ProtocolError);
    // A refused ACK drops nothing.
    expect(log.frames).toBe(3);
    expect(log.acked).toBe(2);
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "resends every frame after a received count of %d, in order",
    (received) => {
      const log = logWith(5);
      expect(log.refusal(received)).toBeUndefined();
      const resent = log.resume(received);
      expect(countsOf(resent)).toEqual(
        [1, 2, 3, 4, 5].filter((count) => count > received),
      );
      // The received count acknowledged everything up to it.
      expect(log.acked).toBe(received);
      expect(log.frames).toBe(5 - received);
    },
  );

  it("keeps counting after a resume", () => {
    const log = logWith(3);
    log.resume(1);
    log.append(frame(4));
    expect(countsOf(log.resume(2))).toEqual([3, 4]);
  });

  it("refuses a resume from a count it was never sent, or one below its ACK", () => {
    const log = logWith(5);
    log.acknowledge(3);
    expect(log.refusal(6)).toBe("count_mismatch");
    expect(log.refusal(2)).toBe("count_mismatch");
    expect(log.refusal(-1)).toBe("count_mismatch");
    expect(() => log.resume(6)).toThrow(ProtocolError);
    expect(log.acked).toBe(3);
  });

  it("drops the oldest frames past its limit", () => {
    // Each frame is 4 bytes; 12 bytes holds 3.
    const log = logWith(5, 12);
    expect(log.sent).toBe(5);
    expect(log.frames).toBe(3);
    expect(log.bytes).toBe(12);
    expect(countsOf(log.resume(2))).toEqual([3, 4, 5]);
  });

  it("refuses a resume that needs a dropped frame", () => {
    const log = logWith(5, 12);
    expect(log.refusal(0)).toBe("log_truncated");
    expect(log.refusal(1)).toBe("log_truncated");
    expect(log.refusal(2)).toBeUndefined();
    expect(() => log.resume(1)).toThrow(ProtocolError);
  });

  it("accepts an ACK below what it dropped", () => {
    const log = logWith(5, 12);
    log.acknowledge(1);
    expect(log.frames).toBe(3);
    log.acknowledge(4);
    expect(countsOf(log.resume(4))).toEqual([5]);
  });

  it("drops even the newest frame when it alone is past the limit", () => {
    const log = new ReplayLog(10);
    log.append(frame(1, 4));
    log.append(frame(2, 20));
    expect(log.frames).toBe(0);
    expect(log.bytes).toBe(0);
    expect(log.refusal(1)).toBe("log_truncated");
    expect(log.refusal(2)).toBeUndefined();
  });

  it("bounds its memory under a peer that never acknowledges", () => {
    const log = new ReplayLog(64 * 1024);
    for (let count = 1; count <= 100_000; count += 1) {
      log.append(frame(count, 100));
    }
    expect(log.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(log.sent).toBe(100_000);
    expect(log.refusal(100_000 - log.frames)).toBeUndefined();
    expect(log.refusal(100_000 - log.frames - 1)).toBe("log_truncated");
  });

  it("restored from counts, resends nothing it held before", () => {
    const log = new ReplayLog(1024, { sent: 7, acked: 4 });
    expect(log.sent).toBe(7);
    expect(log.acked).toBe(4);
    expect(log.frames).toBe(0);
    expect(log.refusal(5)).toBe("log_truncated");
    expect(log.refusal(7)).toBeUndefined();
    log.append(frame(8));
    expect(countsOf(log.resume(7))).toEqual([8]);
  });
});

describe("the ACK schedule", () => {
  it("arms the delay at the first frame and waits after that", () => {
    const acks = new AckSchedule(100);
    expect(acks.processed(10)).toBe("arm");
    expect(acks.processed(10)).toBe("wait");
    expect(acks.take()).toBe(2);
    expect(acks.processed(10)).toBe("arm");
  });

  it("acknowledges at once after its byte budget", () => {
    const acks = new AckSchedule(100);
    expect(acks.processed(60)).toBe("arm");
    expect(acks.processed(40)).toBe("now");
    expect(acks.take()).toBe(2);
    // The budget starts again from the ACK.
    expect(acks.processed(99)).toBe("arm");
  });

  it("has nothing to acknowledge when nothing was processed", () => {
    const acks = new AckSchedule(100);
    expect(acks.take()).toBeUndefined();
    acks.processed(1);
    acks.take();
    expect(acks.take()).toBeUndefined();
  });

  it("acknowledges everything for a resume header", () => {
    const acks = new AckSchedule(100);
    acks.processed(1);
    acks.processed(1);
    expect(acks.acknowledgeAll()).toBe(2);
    expect(acks.take()).toBeUndefined();
    expect(acks.acknowledgeAll()).toBe(2);
  });

  it("continues from a restored count", () => {
    const acks = new AckSchedule(100, { received: 9 });
    expect(acks.received).toBe(9);
    expect(acks.take()).toBeUndefined();
    expect(acks.processed(1)).toBe("arm");
    expect(acks.take()).toBe(10);
  });
});

describe("a count in a resume header", () => {
  it.each([
    ["0", 0],
    ["42", 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("reads %s", (value, count) => {
    expect(parseCount(value)).toBe(count);
  });

  it.each([
    null,
    undefined,
    "",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "0x10",
    "9007199254740992",
    "99999999999999999",
  ])("refuses %s", (value) => {
    expect(parseCount(value)).toBeUndefined();
  });
});
