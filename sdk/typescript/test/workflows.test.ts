import { describe, it, expect, vi } from "vitest";

import { AmikaClient } from "@/client";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

function activeSandbox(name: string) {
  return { id: "1", name, state: "active", repo_url: "" };
}

describe("AmikaClient.createSandboxAndWait", () => {
  it("creates a sandbox and polls until ready", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: activeSandbox("dev") },
      ]);
      const client = makeClient(fetch);
      const promise = client.createSandboxAndWait({ name: "dev", repoUrl: "x" });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);

      const sb = await promise;
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes`);
      expect(sb.state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AmikaClient.withSandbox", () => {
  it("deletes the sandbox after fn resolves", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
        { status: 200, body: activeSandbox("dev") },
        { status: 204, body: "" },
      ]);
      const client = makeClient(fetch);
      const promise = client.withSandbox({ name: "dev" }, async (sb) => {
        expect(sb.state).toBe("active");
        return "done";
      });

      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result).toBe("done");
      expect(calls.at(-1)?.method).toBe("DELETE");
      expect(calls.at(-1)?.url).toBe(`${BASE}/api/v0beta1/sandboxes/dev`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes the sandbox when fn throws", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
      { status: 200, body: activeSandbox("dev") },
      { status: 204, body: "" },
    ]);
    const client = makeClient(fetch);
    await expect(
      client.withSandbox({ name: "dev" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("skips delete when deleteOnExit is false", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
        { status: 200, body: activeSandbox("dev") },
      ]);
      const client = makeClient(fetch);
      const promise = client.withSandbox(
        { name: "dev" },
        async () => "ok",
        { deleteOnExit: false },
      );

      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBe("ok");
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still deletes when waitForSandbox fails", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
      {
        status: 200,
        body: { name: "dev", state: "failed", error_message: "no capacity" },
      },
      { status: 204, body: "" },
    ]);
    const client = makeClient(fetch);
    await expect(
      client.withSandbox({ name: "dev" }, async () => "unused"),
    ).rejects.toThrow(/no capacity/);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });
});

describe("AmikaClient.runAgent", () => {
  it("provisions a sandbox, sends a message, and deletes afterward", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        { status: 202, body: { id: "1", name: "dev", state: "initializing" } },
        { status: 200, body: activeSandbox("dev") },
        {
          status: 200,
          body: { response: "ok", session_id: "s1", is_error: false },
        },
        { status: 204, body: "" },
      ]);
      const client = makeClient(fetch);
      const promise = client.runAgent({
        name: "dev",
        repoUrl: "git@github.com:org/proj.git",
        message: "hello",
        agent: "claude",
        newSession: true,
      });

      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result.result).toBe("ok");
      expect(result.sessionId).toBe("s1");
      expect(result.sandbox.name).toBe("dev");
      expect(calls.some((c) => c.url.endsWith("/agent-send"))).toBe(true);
      expect(calls.at(-1)?.method).toBe("DELETE");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AmikaClient.waitForSandbox options", () => {
  it("respects timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(start);

      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "initializing" } },
      ]);
      const client = makeClient(fetch);
      const promise = client.waitForSandbox("dev", {
        timeoutMs: 100,
        pollIntervalMs: 50,
      });
      const rejection = expect(promise).rejects.toThrow(
        /timed out waiting for sandbox/,
      );

      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(new Date(start.getTime() + 101));
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onPoll after each poll", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: activeSandbox("dev") },
      ]);
      const client = makeClient(fetch);
      const states: string[] = [];
      const promise = client.waitForSandbox("dev", {
        pollIntervalMs: 100,
        onPoll: (sb) => states.push(sb.state),
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(states).toEqual(["initializing", "active"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the abort signal fires", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "initializing" } },
      ]);
      const client = makeClient(fetch);
      const controller = new AbortController();
      const promise = client.waitForSandbox("dev", {
        pollIntervalMs: 1_000,
        signal: controller.signal,
      });

      const rejection = expect(promise).rejects.toThrow(/was aborted/);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
