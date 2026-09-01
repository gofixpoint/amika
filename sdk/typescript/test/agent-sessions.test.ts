import { describe, it, expect } from "vitest";

import { AmikaClient } from "@/client";
import { AmikaError, AmikaHTTPError } from "@/errors";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

/** Serialize SSE frames the way the server does: one `data:` line per frame. */
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

describe("AmikaClient.sendAgentSession", () => {
  it("POSTs camelCase → snake_case and maps the response", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          ...DONE_PAYLOAD,
          usage: { cost_usd: 0.12, input_tokens: 10, num_turns: 2 },
        },
      },
    ]);
    const resp = await makeClient(fetch).sendAgentSession({
      message: "hi",
      agent: "claude",
      sessionId: "as_1",
      sandboxId: "sbx_1",
      newSession: false,
      repoUrl: "git@github.com:org/p.git",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "hi",
      agent: "claude",
      session_id: "as_1",
      sandbox_id: "sbx_1",
      new_session: false,
      repo_url: "git@github.com:org/p.git",
    });
    expect(resp.sessionId).toBe("as_1");
    expect(resp.createdSandbox).toBe(true);
    expect(resp.usage).toEqual({
      costUsd: 0.12,
      inputTokens: 10,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      durationMs: undefined,
      numTurns: 2,
    });
  });

  it("sends only the fields that are set", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: DONE_PAYLOAD }]);
    await makeClient(fetch).sendAgentSession({ message: "hi" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ message: "hi" });
  });

  it("leaves usage undefined when the provider reports none", async () => {
    const { fetch } = mockFetch([{ status: 200, body: DONE_PAYLOAD }]);
    const resp = await makeClient(fetch).sendAgentSession({ message: "hi" });
    expect(resp.usage).toBeUndefined();
  });
});

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
        onStatus: (phase, sandboxId) => statuses.push([phase, sandboxId]),
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

describe("AmikaClient.listAgentSessions", () => {
  it("GETs the envelope and maps nullable columns", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          sessions: [
            {
              session_id: "as_1",
              sandbox_id: "sbx_1",
              sandbox_name: null,
              agent: "claude",
              status: "running",
              preview: "fix the bug",
              model: null,
              effort: "high",
              started_at: "2026-01-01T00:00:00Z",
              ended_at: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
          total: 12,
        },
      },
    ]);
    const page = await makeClient(fetch).listAgentSessions();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions`);
    expect(page.total).toBe(12);
    expect(page.sessions[0]?.sandboxName).toBeNull();
    expect(page.sessions[0]?.model).toBeNull();
    expect(page.sessions[0]?.effort).toBe("high");
  });

  it("passes a positive limit as a query param", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { sessions: [], total: 0 } },
    ]);
    await makeClient(fetch).listAgentSessions(5);
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions?limit=5`);
  });

  it("omits a zero limit and returns [] for an empty page", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { total: 0 } }]);
    const page = await makeClient(fetch).listAgentSessions(0);
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions`);
    expect(page.sessions).toEqual([]);
  });
});

describe("AmikaClient.getAgentSession", () => {
  it("GETs one chat with its transcript", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          session_id: "as/1",
          sandbox_id: "sbx_1",
          sandbox_name: "dev",
          agent: "claude",
          status: "completed",
          preview: null,
          model: "claude-opus-5",
          effort: null,
          started_at: "2026-01-01T00:00:00Z",
          ended_at: "2026-01-01T00:05:00Z",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:05:00Z",
          messages: [
            { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" },
            {
              role: "assistant",
              content: "nope",
              timestamp: "2026-01-01T00:05:00Z",
              is_error: true,
            },
          ],
        },
      },
    ]);
    const detail = await makeClient(fetch).getAgentSession("as/1");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions/as%2F1`);
    expect(detail.model).toBe("claude-opus-5");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]?.isError).toBeUndefined();
    expect(detail.messages[1]?.isError).toBe(true);
  });
});
