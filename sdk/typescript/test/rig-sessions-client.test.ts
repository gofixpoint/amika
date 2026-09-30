import { describe, it, expect } from "vitest";
import { AmikaClient } from "@/index";
import { AmikaHTTPError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

describe("AmikaClient sessions", () => {
  it("createSession POSTs camelCase → snake_case", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 201,
        body: {
          id: "s1",
          agent_name: "claude",
          started_at: "2026-01-01T00:00:00Z",
        },
      },
    ]);
    const client = makeClient(fetch);
    const sess = await client.createSession("dev", {
      agentName: "claude",
      metadata: { intent: "test" },
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev/sessions`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      agent_name: "claude",
      metadata: { intent: "test" },
    });
    expect(sess.agentName).toBe("claude");
  });

  it("listSessions unwraps the {sessions, total} envelope", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          sessions: [
            { id: "s1", agent_name: "claude", preview: "fix the bug" },
            { id: "s2", agent_name: "codex" },
          ],
          total: 2,
        },
      },
    ]);
    const client = makeClient(fetch);
    const sessions = await client.listSessions("dev");
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.agentName).toBe("codex");
    // `preview` is returned on list responses only.
    expect(sessions[0]?.preview).toBe("fix the bug");
    expect(sessions[1]?.preview).toBeUndefined();
  });

  it("decodes sandbox_id, the name the schema uses for a session's rig", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { id: "s1", sandbox_id: "sbx_1" } },
    ]);
    const sess = await makeClient(fetch).getSession("dev", "s1");
    expect(sess.sandboxId).toBe("sbx_1");
  });

  it("getLatestSession returns null on 404", async () => {
    const { fetch } = mockFetch([
      { status: 404, body: { message: "no sessions" } },
    ]);
    const client = makeClient(fetch);
    expect(await client.getLatestSession("dev")).toBeNull();
  });

  it("getLatestSession rethrows non-404 errors", async () => {
    const { fetch } = mockFetch([{ status: 500, body: { message: "boom" } }]);
    const client = makeClient(fetch);
    await expect(client.getLatestSession("dev")).rejects.toBeInstanceOf(
      AmikaHTTPError,
    );
  });

  it("updateSession PATCHes to /sessions/{id}", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { id: "s1", status: "completed", agent_name: "claude" },
      },
    ]);
    const client = makeClient(fetch);
    await client.updateSession("dev", "s1", { status: "completed" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev/sessions/s1`);
  });
});
