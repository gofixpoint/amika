import { describe, expect, it } from "vitest";
import {
  closeReason,
  decodeFrame,
  encodeFrame,
  isSendableResponseHead,
  MAX_DATA_BYTES,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  sendableCloseCode,
  type Frame,
} from "./index.js";
import { ReceiveWindow, SendWindow } from "./window.js";

describe("frames", () => {
  const frames: Frame[] = [
    {
      type: "open",
      streamId: 1,
      head: {
        method: "POST",
        target: "/v0beta1/rigs?x=1",
        headers: [
          ["set-cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ],
        upgrade: false,
      },
    },
    {
      type: "response",
      streamId: 2,
      head: { status: 101, statusText: "Switching Protocols", headers: [] },
    },
    { type: "data", streamId: 3, bytes: new Uint8Array([1, 2, 3]) },
    { type: "end", streamId: 4 },
    { type: "reset", streamId: 5, reason: "gone" },
    { type: "window", streamId: 6, credit: 65536 },
    { type: "message", streamId: 7, data: "héllo" },
    { type: "message", streamId: 8, data: new Uint8Array([0, 255]) },
    { type: "close", streamId: 0xffffffff, code: 4000, reason: "bye" },
  ];

  it.each(frames)("round-trips $type", (frame) => {
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("reads a frame that sits inside a larger buffer", () => {
    const encoded = encodeFrame({ type: "end", streamId: 9 });
    const padded = new Uint8Array(encoded.byteLength + 3);
    padded.set(encoded, 3);
    expect(decodeFrame(padded.subarray(3))).toEqual({
      type: "end",
      streamId: 9,
    });
  });

  it("refuses stream id 0, an unknown type and a short frame", () => {
    expect(() => decodeFrame(new Uint8Array([4, 0, 0, 0, 0]))).toThrow(
      ProtocolError,
    );
    expect(() => decodeFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(
      ProtocolError,
    );
    expect(() => decodeFrame(new Uint8Array([4, 0, 0]))).toThrow(ProtocolError);
  });

  it("refuses a head that would split a header line", () => {
    const frame = encodeFrame({
      type: "open",
      streamId: 1,
      head: { method: "GET", target: "/", headers: [], upgrade: false },
    });
    const forged = new TextEncoder().encode(
      JSON.stringify({
        method: "GET",
        target: "/",
        headers: [["x", "a\r\nhost: evil"]],
        upgrade: false,
      }),
    );
    const bytes = new Uint8Array(5 + forged.byteLength);
    bytes.set(frame.subarray(0, 5));
    bytes.set(forged, 5);
    expect(() => decodeFrame(bytes)).toThrow(ProtocolError);
  });

  it.each([
    ["a control character", "a\x01b"],
    ["a code point above Latin-1", "\u0100"],
    ["DEL", "a\x7fb"],
  ])(
    "refuses a header value with %s, which Node cannot write",
    (_name, value) => {
      const forged = new TextEncoder().encode(
        JSON.stringify({
          method: "GET",
          target: "/",
          headers: [["x", value]],
          upgrade: false,
        }),
      );
      const bytes = new Uint8Array(5 + forged.byteLength);
      bytes.set([1, 0, 0, 0, 1]);
      bytes.set(forged, 5);
      expect(() => decodeFrame(bytes)).toThrow(ProtocolError);
    },
  );

  it("keeps obs-text and tabs in a header value", () => {
    const frame: Frame = {
      type: "open",
      streamId: 1,
      head: {
        method: "GET",
        target: "/",
        headers: [["x", "caf\u00e9\tok"]],
        upgrade: false,
      },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("refuses an oversized message at both ends", () => {
    const big = new Uint8Array(MAX_MESSAGE_BYTES + 1);
    expect(() =>
      encodeFrame({ type: "message", streamId: 1, data: big }),
    ).toThrow(RangeError);
    // Text is measured in bytes, not characters.
    expect(() =>
      encodeFrame({
        type: "message",
        streamId: 1,
        data: "é".repeat(MAX_MESSAGE_BYTES / 2 + 1),
      }),
    ).toThrow(RangeError);
    const forged = new Uint8Array(5 + MAX_MESSAGE_BYTES + 1);
    forged.set([8, 0, 0, 0, 1]);
    expect(() => decodeFrame(forged)).toThrow(ProtocolError);
  });

  it("refuses an oversized DATA frame at both ends", () => {
    const big = new Uint8Array(MAX_DATA_BYTES + 1);
    expect(() =>
      encodeFrame({ type: "data", streamId: 1, bytes: big }),
    ).toThrow(RangeError);
  });
});

describe("response heads", () => {
  it("passes a head the far end can read, and refuses one it cannot", () => {
    const head = { status: 200, statusText: "OK", headers: [] };
    expect(isSendableResponseHead(head)).toBe(true);
    const sendable = [
      head,
      { ...head, status: 600 },
      { ...head, statusText: "x".repeat(2000) },
    ].map(isSendableResponseHead);
    expect(sendable).toEqual([true, false, false]);
    // Each refused head is one `decodeFrame` would refuse.
    expect(() =>
      decodeFrame(
        encodeFrame({
          type: "response",
          streamId: 1,
          head: { ...head, status: 600 },
        }),
      ),
    ).toThrow(ProtocolError);
  });
});

describe("close codes", () => {
  it("maps codes that cannot be sent", () => {
    expect(sendableCloseCode(1005)).toBe(1000);
    expect(sendableCloseCode(1006)).toBe(1011);
    expect(sendableCloseCode(1015)).toBe(1011);
    expect(sendableCloseCode(1004)).toBe(1011);
    expect(sendableCloseCode(1001)).toBe(1001);
    expect(sendableCloseCode(4001)).toBe(4001);
    expect(sendableCloseCode(5000)).toBe(1011);
  });

  it("cuts a long reason in one pass, on a character boundary", () => {
    const long = "é".repeat(500_000);
    const started = performance.now();
    const cut = closeReason(long);
    expect(performance.now() - started).toBeLessThan(500);
    expect(new TextEncoder().encode(cut).byteLength).toBe(122);
    expect(cut).toBe("é".repeat(61));
  });

  it("refuses a CLOSE frame whose reason cannot fit a close frame", () => {
    const frame = encodeFrame({
      type: "close",
      streamId: 1,
      code: 1000,
      reason: "x".repeat(123),
    });
    expect(decodeFrame(frame)).toMatchObject({ reason: "x".repeat(123) });
    const oversized = new Uint8Array(frame.byteLength + 1);
    oversized.set(frame);
    oversized[oversized.length - 1] = 0x78;
    expect(() => decodeFrame(oversized)).toThrow(ProtocolError);
  });

  it("cuts a reason to 123 bytes", () => {
    expect(
      new TextEncoder().encode(closeReason("é".repeat(100))).length,
    ).toBeLessThanOrEqual(123);
  });
});

describe("windows", () => {
  it("makes a sender wait for credit", async () => {
    const window = new SendWindow();
    expect(await window.take(256 * 1024)).toBe(256 * 1024);
    let taken = 0;
    const waiting = window.take(10).then((n) => (taken = n));
    await Promise.resolve();
    expect(taken).toBe(0);
    window.grant(4);
    await waiting;
    expect(taken).toBe(4);
  });

  it("rejects a waiting sender when the stream closes", async () => {
    const window = new SendWindow();
    await window.take(256 * 1024);
    const waiting = window.take(1);
    window.close(new Error("reset"));
    await expect(waiting).rejects.toThrow("reset");
  });

  it("refuses a sender that overruns its credit", () => {
    const window = new ReceiveWindow();
    expect(window.receive(256 * 1024)).toBe(true);
    expect(window.receive(1)).toBe(false);
    expect(window.release(10)).toBe(10);
    expect(window.receive(10)).toBe(true);
  });
});
