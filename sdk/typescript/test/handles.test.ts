import { afterEach, describe, expect, it, vi } from "vitest";
import { AmikaClient, AmikaHTTPError, AmikaWaitError } from "@/index";
import { mockFetch } from "@test/helpers";

const ready = {
  id: "rig/1",
  name: "dev",
  state: "active",
  status: "running",
  setup_status: "ok",
};
const options = { apiKey: "test-key", baseUrl: "https://api.example.com" };
afterEach(() => vi.useRealTimers());

describe("rig handles and eager lookups", () => {
  it("constructs an unchecked handle and deletes without a preliminary lookup", async () => {
    const { fetch, calls } = mockFetch([{ status: 204 }]);
    const client = new AmikaClient({ ...options, fetch });
    const handle = client.rigs.handle("absent/name");
    expect(calls).toEqual([]);
    expect(handle).not.toHaveProperty("status");
    expect(handle).not.toHaveProperty("then");
    await handle.delete();
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "https://api.example.com/api/v0beta1/rigs/absent%2Fname"],
    ]);
  });

  it("get fetches once and returns a stopped rig without starting or waiting", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          ...ready,
          status: "suspended",
          hostname: "dev.example",
          host_id: "host1",
          agent_cwd: "/workspace",
          ssh_key_status: "ready",
        },
      },
    ]);
    const rig = await new AmikaClient({ ...options, fetch }).rigs.get("dev");
    expect(calls).toHaveLength(1);
    expect(rig).toMatchObject({
      status: "suspended",
      hostname: "dev.example",
      hostId: "host1",
      agentCwd: "/workspace",
      sshKeyStatus: "ready",
    });
  });

  it("getAndWait uses its initial response as the first observation", async () => {
    const { fetch, calls } = mockFetch([{ body: ready }]);
    const rig = await new AmikaClient({ ...options, fetch }).rigs.getAndWait(
      "dev",
    );
    expect(rig.status).toBe("running");
    expect(calls).toHaveLength(1);
  });

  it("wait resolves the name once, follows the ID, and checks setup", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch([
      { body: { ...ready, setup_status: "setup-running" } },
      { body: { ...ready, name: "renamed" } },
    ]);
    const pending = new AmikaClient({ ...options, fetch }).rigs
      .handle("dev")
      .wait({ pollMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({
      id: "rig/1",
      name: "renamed",
      setupStatus: "ok",
    });
    expect(calls.map((c) => c.url.split("/rigs/")[1])).toEqual([
      "dev",
      "rig%2F1",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports 404 immediately instead of waiting for a nonexistent record to appear", async () => {
    const { fetch, calls } = mockFetch([{ status: 404, body: "missing" }]);
    await expect(
      new AmikaClient({ ...options, fetch }).rigs.getAndWait("missing"),
    ).rejects.toBeInstanceOf(AmikaHTTPError);
    expect(calls).toHaveLength(1);
  });

  it("includes the initial token load in getAndWait's deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    let resolveToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const client = new AmikaClient({
      fetch,
      tokenSource: { token: () => token },
    });
    const rejected = expect(
      client.rigs.getAndWait("dev", { maxWaitMs: 20 }),
    ).rejects.toMatchObject({ reason: "timeout", rigId: "" });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    resolveToken("late-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the same object and binds mutations to its stable ID", async () => {
    const { fetch, calls } = mockFetch([
      { body: ready },
      { body: { ...ready, name: "renamed", status: "suspended" } },
      { status: 204 },
      { status: 204 },
    ]);
    const rig = await new AmikaClient({ ...options, fetch }).rigs
      .handle("dev")
      .fetch();
    expect(await rig.refresh()).toBe(rig);
    expect(rig.status).toBe("suspended");
    await rig.start();
    await rig.stop();
    expect(
      calls.slice(1).map((c) => [c.method, c.url.split("/rigs/")[1]]),
    ).toEqual([
      ["GET", "rig%2F1"],
      ["POST", "rig%2F1/start"],
      ["POST", "rig%2F1/stop"],
    ]);
    expect(JSON.stringify(rig)).not.toMatch(/test-key|refresh|transport|fetch/);
  });

  it("surfaces setup failures from a handle as AmikaWaitError", async () => {
    const { fetch } = mockFetch([
      { body: { ...ready, setup_status: "git-failed" } },
    ]);
    await expect(
      new AmikaClient({ ...options, fetch }).rigs.handle("dev").wait(),
    ).rejects.toBeInstanceOf(AmikaWaitError);
  });
});

describe("snapshot resources", () => {
  it("reports capture failure immediately with server details", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          id: "snap1",
          state: "failed",
          error_message: "capture failed on provider",
        },
      },
    ]);
    await expect(
      new AmikaClient({ ...options, fetch }).snapshots.handle("base").wait(),
    ).rejects.toThrow("capture failed on provider");
    expect(calls).toHaveLength(1);
  });

  it("constructs an unchecked snapshot handle and deletes directly", async () => {
    const { fetch, calls } = mockFetch([{ status: 204 }]);
    const handle = new AmikaClient({ ...options, fetch }).snapshots.handle(
      "base/name",
    );
    expect(calls).toEqual([]);
    await handle.delete();
    expect(calls[0]?.url).toBe(
      "https://api.example.com/api/v0beta1/rig-snapshots/base%2Fname?by=ref",
    );
  });

  it("returns a capture resource whose wait updates it and whose methods do not serialize", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch([
      { body: { id: "snap/1", snapshot: "base", state: "capturing" } },
      { body: { id: "snap/1", state: "capturing" } },
      { body: { id: "snap/1", snapshot: "base", state: "active" } },
      { status: 204 },
    ]);
    const snapshot = await new AmikaClient({
      ...options,
      fetch,
    }).snapshots.create({ rigRef: "dev", name: "base", mode: "full" });
    const pending = snapshot.wait({ pollMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe(snapshot);
    expect(snapshot.state).toBe("active");
    await snapshot.delete();
    expect(calls[1]?.url).toContain("snap%2F1?by=ref");
    expect(JSON.stringify(snapshot)).not.toMatch(/test-key|wait|delete|fetch/);
  });

  it("bounds the first snapshot fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;
    const rejected = expect(
      new AmikaClient({ ...options, fetch }).snapshots
        .handle("base")
        .wait({ maxWaitMs: 20 }),
    ).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
