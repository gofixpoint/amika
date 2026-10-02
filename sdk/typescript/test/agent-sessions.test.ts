import { describe, it, expect } from "vitest";
import { AmikaClient } from "@/index";
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
      rigId: "sbx_1",
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
    expect(resp.sandboxId).toBe("sbx_1");
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

  it.each([
    { model: "opus", effort: "high" as const },
    { model: null, effort: null },
    {},
  ])(
    "preserves model/effort values, resets, and omission in both send APIs",
    async (settings) => {
      const { fetch, calls } = mockFetch([
        { body: DONE_PAYLOAD },
        { body: sse(["done", DONE_PAYLOAD]) },
      ]);
      const client = makeClient(fetch);
      await client.sendAgentSession({ message: "hi", ...settings });
      await client.sendAgentSessionStream({ message: "hi", ...settings });
      for (const call of calls) {
        expect(JSON.parse(call.body ?? "")).toEqual({
          message: "hi",
          ...settings,
        });
      }
    },
  );

  it("sends only the fields that are set", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: DONE_PAYLOAD }]);
    await makeClient(fetch).sendAgentSession({ message: "hi" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ message: "hi" });
  });

  it("accepts the legacy sandboxId spelling, and prefers a non-empty rigId", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: DONE_PAYLOAD },
      { status: 200, body: DONE_PAYLOAD },
      { status: 200, body: DONE_PAYLOAD },
      { status: 200, body: DONE_PAYLOAD },
    ]);
    const client = makeClient(fetch);
    await client.sendAgentSession({ message: "hi", sandboxId: "sbx_1" });
    await client.sendAgentSession({
      message: "hi",
      rigId: "rig_1",
      sandboxId: "sbx_1",
    });
    // An empty rig spelling falls through rather than shadowing the legacy one,
    // matching the other two sites that accept both spellings.
    await client.sendAgentSession({
      message: "hi",
      rigId: "",
      sandboxId: "sbx_1",
    });
    // An explicitly empty legacy value is still sent, exactly as 0.11 sent it.
    await client.sendAgentSession({ message: "hi", sandboxId: "" });
    expect(JSON.parse(calls[0]?.body ?? "").sandbox_id).toBe("sbx_1");
    expect(JSON.parse(calls[1]?.body ?? "").sandbox_id).toBe("rig_1");
    expect(JSON.parse(calls[2]?.body ?? "").sandbox_id).toBe("sbx_1");
    expect(JSON.parse(calls[3]?.body ?? "").sandbox_id).toBe("");
  });

  it("leaves usage undefined when the provider reports none", async () => {
    const { fetch } = mockFetch([{ status: 200, body: DONE_PAYLOAD }]);
    const resp = await makeClient(fetch).sendAgentSession({ message: "hi" });
    expect(resp.usage).toBeUndefined();
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
    expect(page.sessions[0]?.sandboxId).toBe("sbx_1");
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

  it("filters by rig as sandbox alongside limit", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { sessions: [], total: 0 } },
      { status: 200, body: { sessions: [], total: 0 } },
    ]);
    const client = makeClient(fetch);
    await client.agentSessions.list({ rigRef: "dev box", limit: 5 });
    await client.agentSessions.list({ rigRef: "" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/agent-sessions?limit=5&sandbox=dev+box`,
    );
    expect(calls[1]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions`);
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
    expect(detail.sandboxName).toBe("dev");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]?.isError).toBeUndefined();
    expect(detail.messages[1]?.isError).toBe(true);
  });
});
