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

describe("AmikaClient.agentSend", () => {
  it.each(["", " \t\n"])(
    "rejects a blank rig name %j before sending",
    async (name) => {
      const { fetch, calls } = mockFetch([]);
      await expect(
        makeClient(fetch).agentSend(name, { message: "hello" }),
      ).rejects.toThrow("rig name must not be empty");
      expect(calls).toHaveLength(0);
    },
  );

  it("uses the durable agent-sessions API and response format", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          session_id: "chat1",
          sandbox_id: "sb1",
          agent: "codex",
          response: "ok",
          is_error: false,
          is_new_session: false,
          created_sandbox: false,
          usage: { cost_usd: 0.42 },
        },
      },
    ]);
    const resp = await makeClient(fetch).agentSend("org/dev", {
      message: "do it",
      sessionId: "chat1",
      agent: "codex",
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/agent-sessions`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "do it",
      sandbox_id: "org/dev",
      session_id: "chat1",
      agent: "codex",
    });
    expect(resp).toMatchObject({
      response: "ok",
      sessionId: "chat1",
      sandboxId: "sb1",
      agent: "codex",
      isError: false,
      isNewSession: false,
      createdSandbox: false,
      usage: { costUsd: 0.42 },
    });
  });

  it("returns agent failures in the session response", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          session_id: "chat1",
          sandbox_id: "sb1",
          agent: "claude",
          response: "Not logged in",
          is_error: true,
          is_new_session: false,
          created_sandbox: false,
        },
      },
    ]);
    const resp = await makeClient(fetch).agentSend("dev", { message: "hi" });
    expect(resp.isError).toBe(true);
    expect(resp.response).toBe("Not logged in");
  });
});
