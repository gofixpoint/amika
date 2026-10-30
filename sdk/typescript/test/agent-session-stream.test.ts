import { describe, it, expect } from "vitest";
import { AmikaClient } from "@/index";
import { AmikaError, AmikaHTTPError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

function sse(...frames: [event: string, payload: unknown][]): string {
  return frames
    .map(
      ([event, payload]) =>
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
    )
    .join("");
}

const DONE_PAYLOAD = {
  session_id: "as_1",
  sandbox_id: "sbx_1",
  agent: "claude",
  response: "hello",
  is_error: false,
  is_new_session: true,
  created_sandbox: true,
};

describe("AmikaClient.sendAgentSessionStream", () => {
  it("dispatches status and delta frames, then returns the done result", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: sse(
          ["status", { phase: "creating_sandbox", sandbox_id: "" }],
          ["status", { phase: "sandbox_ready", sandbox_id: "sbx_1" }],
          ["delta", { text: "hel" }],
          ["delta", { text: "lo" }],
          ["done", DONE_PAYLOAD],
        ),
      },
    ]);

    const statuses: [string, string][] = [];
    let text = "";
    const resp = await makeClient(fetch).sendAgentSessionStream(
      { message: "hi" },
      {
        onStatus: (phase, rigId) => statuses.push([phase, rigId]),
        onDelta: (chunk) => {
          text += chunk;
        },
      },
    );

    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions/stream`);
    expect(calls[0]?.headers["Accept"]).toBe("text/event-stream");
    expect(statuses).toEqual([
      ["creating_sandbox", ""],
      ["sandbox_ready", "sbx_1"],
    ]);
    expect(text).toBe("hello");
    expect(resp.response).toBe("hello");
  });

  it("works without handlers", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: sse(["delta", { text: "x" }], ["done", DONE_PAYLOAD]),
      },
    ]);
    const resp = await makeClient(fetch).sendAgentSessionStream({
      message: "hi",
    });
    expect(resp.sessionId).toBe("as_1");
  });

  it("prefers a done frame over an error frame", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: sse(["error", { error: "boom" }], ["done", DONE_PAYLOAD]),
      },
    ]);
    const resp = await makeClient(fetch).sendAgentSessionStream({
      message: "hi",
    });
    expect(resp.sessionId).toBe("as_1");
  });

  it("throws the message from an error frame", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: sse(["error", { error: "agent exploded" }]) },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/agent exploded/);
  });

  it("points at the session list when the stream ends with no result", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: sse(["delta", { text: "partial" }]) },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/stream ended without a result/);
  });

  it("fails loudly on an unparseable delta rather than losing output", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: "event: delta\ndata: {not json\n\n" },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(AmikaError);
  });

  it("surfaces a pre-stream rejection as an HTTP error", async () => {
    const { fetch } = mockFetch([
      { status: 401, body: { code: "unauthorized", message: "bad token" } },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(AmikaHTTPError);
  });
});

describe("AmikaClient.sendAgentSessionStream async handlers", () => {
  it("awaits an async onDelta so text arrives in order", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: sse(
          ["delta", { text: "first" }],
          ["delta", { text: "second" }],
          ["delta", { text: "third" }],
          ["done", DONE_PAYLOAD],
        ),
      },
    ]);

    const written: string[] = [];
    // The first chunk takes the longest to write. Without an await the
    // reader would race ahead and the writes would land out of order.
    const delays: Record<string, number> = { first: 30, second: 10, third: 0 };
    await makeClient(fetch).sendAgentSessionStream(
      { message: "hi" },
      {
        onDelta: async (text) => {
          await new Promise((r) => setTimeout(r, delays[text] ?? 0));
          written.push(text);
        },
      },
    );

    expect(written).toEqual(["first", "second", "third"]);
  });

  it("awaits an async onStatus before the next frame", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: sse(
          ["status", { phase: "creating_sandbox", sandbox_id: "" }],
          ["delta", { text: "x" }],
          ["done", DONE_PAYLOAD],
        ),
      },
    ]);

    const order: string[] = [];
    await makeClient(fetch).sendAgentSessionStream(
      { message: "hi" },
      {
        onStatus: async (phase) => {
          await new Promise((r) => setTimeout(r, 20));
          order.push(`status:${phase}`);
        },
        onDelta: (text) => {
          order.push(`delta:${text}`);
        },
      },
    );

    expect(order).toEqual(["status:creating_sandbox", "delta:x"]);
  });

  it("fails the send when a handler rejects", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: sse(["delta", { text: "x" }], ["done", DONE_PAYLOAD]),
      },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream(
        { message: "hi" },
        {
          onDelta: () => Promise.reject(new Error("writer closed")),
        },
      ),
    ).rejects.toThrow(/writer closed/);
  });
});

describe("AmikaClient.sendAgentSessionStream truncated streams", () => {
  // The server's 300s ceiling cuts the connection at an arbitrary byte
  // offset, and the `data:` line is most of every frame's bytes, so a cut
  // lands mid-frame far more often than on a frame boundary. That must read
  // as a lost stream, not as corrupt output.
  it("reports a mid-delta cut as a lost stream, not a parse failure", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: 'event: delta\ndata: {"text":"hello "}\n\nevent: delta\ndata: {"tex',
      },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/stream ended without a result/);
  });

  it("reports a mid-done cut as a lost stream", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: 'event: done\ndata: {"session_id":"as' },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/stream ended without a result/);
  });

  it("keeps an earlier error frame's message when the stream is then cut", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: 'event: error\ndata: {"error":"boom"}\n\nevent: delta\ndata: {"tex',
      },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/boom/);
  });

  // A complete final frame from a server that omitted the trailing blank line
  // is still usable, so the unterminated flag must not discard it outright.
  it("still accepts a complete done frame with no trailing blank line", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: `event: done\ndata: ${JSON.stringify(DONE_PAYLOAD)}`,
      },
    ]);
    const resp = await makeClient(fetch).sendAgentSessionStream({
      message: "hi",
    });
    expect(resp.sessionId).toBe("as_1");
  });

  it("rejects a JSON array in a done frame instead of resolving empty", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: "event: done\ndata: [1,2]\n\n" },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/parsing done frame failed/);
  });
});

describe("AmikaClient agent-session malformed payloads", () => {
  it("treats a non-object usage as absent rather than an empty object", async () => {
    for (const usage of [[1], "x", 3]) {
      const { fetch } = mockFetch([
        { status: 200, body: { ...DONE_PAYLOAD, usage } },
      ]);
      const resp = await makeClient(fetch).sendAgentSession({ message: "hi" });
      expect(resp.usage, `usage=${JSON.stringify(usage)}`).toBeUndefined();
    }
  });

  // A cut mid-error-frame is a lost stream, not a new error, so it must not
  // overwrite a message an earlier error frame already delivered.
  it("keeps an earlier error message when a later error frame is cut", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body:
          'event: error\ndata: {"error":"boom"}\n\n' +
          'event: error\ndata: {"error":"tru',
      },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/boom/);
  });

  it("reports a lone truncated error frame as a lost stream", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: 'event: error\ndata: {"error":"boom bec' },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/stream ended without a result/);
  });

  // The SDK cannot tell a cut connection from a clean close with a corrupt
  // final frame, so the message must not assert only the former.
  it("does not blame the time limit alone for a corrupt final frame", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: "event: delta\ndata: <html>oops</html>" },
    ]);
    await expect(
      makeClient(fetch).sendAgentSessionStream({ message: "hi" }),
    ).rejects.toThrow(/truncated or malformed/);
  });
});
