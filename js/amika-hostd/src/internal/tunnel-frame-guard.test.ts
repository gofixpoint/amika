import { describe, expect, it } from "vitest";
import { YamuxFrameGuard } from "./tunnel-frame-guard.js";

const DATA = 0;
const WINDOW_UPDATE = 1;
const PING = 2;

/** A yamux frame header, and the payload bytes that follow a DATA one. */
function frame(type: number, length: number, payload = 0): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0; // version
  header[1] = type;
  header.writeUInt32BE(5, 4); // stream id
  header.writeUInt32BE(length, 8);
  return Buffer.concat([header, Buffer.alloc(payload)]);
}

const LIMIT = 256 * 1024;

describe("a DATA frame's declared length", () => {
  it("passes at the limit", () => {
    const guard = new YamuxFrameGuard(LIMIT);

    expect(() => guard.consume(frame(DATA, LIMIT, 16))).not.toThrow();
  });

  it("is refused above it, before a byte of payload is buffered", () => {
    const guard = new YamuxFrameGuard(LIMIT);

    expect(() => guard.consume(frame(DATA, LIMIT + 1))).toThrow(
      /declares 262145 bytes/,
    );
  });

  it("is refused even when the header arrives in pieces", () => {
    // The defect this guards is precisely that the decoder accumulates
    // while a frame is incomplete, so a header split across WebSocket
    // messages is the case that matters, not the aligned one.
    const guard = new YamuxFrameGuard(LIMIT);
    const header = frame(DATA, 0xffffffff);

    expect(() => {
      for (const byte of header) guard.consume(Buffer.from([byte]));
    }).toThrow(/declares 4294967295 bytes/);
  });
});

describe("the bytes after a header", () => {
  it("are skipped, so the next header is read in the right place", () => {
    const guard = new YamuxFrameGuard(LIMIT);
    // A payload whose bytes would be a valid oversized header if the guard
    // read them as one.
    const payload = frame(DATA, 0xffffffff);
    guard.consume(Buffer.concat([frame(DATA, payload.length), payload]));

    expect(() => guard.consume(frame(DATA, LIMIT + 1))).toThrow();
  });

  it("do not follow a window update, whose length is a credit", () => {
    // Reading a WINDOW_UPDATE's length as a payload length would put the
    // guard permanently out of step with the frame boundaries, and it
    // would then refuse ordinary traffic.
    const guard = new YamuxFrameGuard(LIMIT);
    guard.consume(frame(WINDOW_UPDATE, 0xffffffff));

    expect(() => guard.consume(frame(DATA, LIMIT + 1))).toThrow(
      /declares 262145 bytes/,
    );
  });

  it("do not follow a ping either", () => {
    const guard = new YamuxFrameGuard(LIMIT);
    guard.consume(frame(PING, 0xffffffff));

    expect(() => guard.consume(frame(DATA, LIMIT + 1))).toThrow();
  });
});

describe("a frame this protocol has no reading for", () => {
  it("is refused by version", () => {
    const guard = new YamuxFrameGuard(LIMIT);
    const header = frame(DATA, 0);
    header[0] = 1;

    expect(() => guard.consume(header)).toThrow(/Unsupported yamux version/);
  });

  it("is refused by type", () => {
    const guard = new YamuxFrameGuard(LIMIT);

    expect(() => guard.consume(frame(4, 0))).toThrow(/Unknown yamux frame/);
  });
});
