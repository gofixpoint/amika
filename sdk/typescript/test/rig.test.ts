import { afterEach, describe, expect, it, vi } from "vitest";
import { AmikaClient } from "@/client";
import { AmikaError, AmikaHTTPError, AmikaWaitError } from "@/errors";
import type { RigWaitOptions } from "@/rig";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";
const ready = {
  id: "rig/1",
  name: "dev",
  state: "active",
  status: "running",
  setup_status: "ok",
};
const starting = {
  ...ready,
  state: "initializing",
  status: "starting",
  setup_status: "setup-running",
};
const client = (fetch: typeof globalThis.fetch) =>
  new AmikaClient({ baseUrl: BASE, apiKey: "secret-key", fetch });

afterEach(() => vi.useRealTimers());

describe("rig resources", () => {
  it.each(["createRig", "getRig", "createSandbox", "getSandbox"] as const)(
    "%s returns bound operations without serializing the client",
    async (method) => {
      const { fetch, calls } = mockFetch([
        { body: starting },
        { body: ready },
        { status: 204 },
      ]);
      const amika = client(fetch);
      const rig =
        method === "createRig" || method === "createSandbox"
          ? await amika[method]({ name: "dev" })
          : await amika[method]("dev");
      const result = await rig.wait();
      expect(result).toBe(rig);
      expect(rig.status).toBe("running");
      expect(rig.setupStatus).toBe("ok");
      const serialized = JSON.stringify(rig);
      expect(serialized).not.toMatch(/wait|delete|secret-key|transport/);
      expect(Object.keys(rig)).not.toContain("wait");
      await rig.delete();
      expect(calls.slice(1).map(({ method, url }) => [method, url])).toEqual([
        ["GET", `${BASE}/api/v0beta1/rigs/rig%2F1`],
        ["DELETE", `${BASE}/api/v0beta1/rigs/rig%2F1`],
      ]);
    },
  );

  it.each(["listRigs", "listSandboxes"] as const)(
    "%s binds each item to its own ID",
    async (method) => {
      const { fetch, calls } = mockFetch([
        { body: [ready, { ...ready, id: "rig/2" }] },
        { status: 204 },
      ]);
      const rigs = await client(fetch)[method]();
      await rigs[1]!.delete();
      expect(calls[1]?.url).toBe(`${BASE}/api/v0beta1/rigs/rig%2F2`);
    },
  );

  it("propagates deletion errors", async () => {
    const { fetch } = mockFetch([
      { body: ready },
      { status: 409, body: "busy" },
    ]);
    const rig = await client(fetch).getRig("dev");
    await expect(rig.delete()).rejects.toBeInstanceOf(AmikaHTTPError);
  });
});

describe("rig.wait", () => {
  it("requires both running and successful setup and uses the default poll interval", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch([
      { body: starting },
      { body: { ...ready, setup_status: "setup-running" } },
      { body: { ...ready, status: "starting" } },
      { body: ready },
    ]);
    const rig = await client(fetch).createRig({});
    const wait = rig.wait();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(wait).resolves.toBe(rig);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stopped", "suspended"] as const)(
    "waits for %s without requiring setup success",
    async (status) => {
      const { fetch } = mockFetch([
        { body: starting },
        { body: { ...ready, status, setup_status: "setup-failed" } },
      ]);
      const rig = await client(fetch).getRig("dev");
      await expect(rig.wait({ status })).resolves.toMatchObject({
        status,
        setupStatus: "setup-failed",
      });
    },
  );

  it("accepts the API's suspended status when waiting for stopped", async () => {
    const { fetch } = mockFetch([
      { body: starting },
      { body: { ...ready, state: "stopped", status: "suspended" } },
    ]);
    const rig = await client(fetch).getRig("dev");
    await expect(rig.wait({ status: "stopped" })).resolves.toMatchObject({
      status: "suspended",
    });
  });

  it("matches any requested status and honors explicit setupStatus", async () => {
    vi.useFakeTimers();
    const { fetch } = mockFetch([
      { body: starting },
      {
        body: { ...ready, status: "suspended", setup_status: "setup-running" },
      },
      { body: { ...ready, status: "suspended" } },
    ]);
    const rig = await client(fetch).getRig("dev");
    const wait = rig.wait({
      status: ["stopped", "suspended"],
      setupStatus: "ok",
      pollMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(wait).resolves.toMatchObject({
      status: "suspended",
      setupStatus: "ok",
    });
  });

  it.each(["setup-failed", "sys-setup-failed", "git-failed"])(
    "throws a custom error for %s",
    async (setupStatus) => {
      const { fetch } = mockFetch([
        { body: starting },
        {
          body: {
            ...ready,
            setup_status: setupStatus,
            error_message: "setup details",
          },
        },
      ]);
      const rig = await client(fetch).getRig("dev");
      const error = await rig.wait().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AmikaWaitError);
      expect(error).toBeInstanceOf(AmikaError);
      expect(error).toMatchObject({
        reason: "setup",
        rigId: "rig/1",
        status: "running",
        setupStatus,
        message: "setup details",
      });
    },
  );

  it.each([{ state: "failed" }, { status: "failed" }])(
    "throws on provisioning failure: %j",
    async (failure) => {
      const { fetch } = mockFetch([
        { body: starting },
        { body: { ...ready, ...failure } },
      ]);
      const rig = await client(fetch).getRig("dev");
      await expect(rig.wait()).rejects.toMatchObject({
        name: "AmikaWaitError",
        reason: "provisioning",
      });
    },
  );

  it("enforces the deadline during a poll sleep and reports the last state", async () => {
    vi.useFakeTimers();
    const { fetch } = mockFetch([
      { body: starting },
      { body: { ...ready, setup_status: undefined } },
    ]);
    const rig = await client(fetch).getRig("dev");
    const wait = rig.wait({ pollMs: 1_000, maxWaitMs: 25 });
    const rejected = expect(wait).rejects.toMatchObject({
      reason: "timeout",
      status: "running",
      setupStatus: undefined,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the default 15-minute deadline", async () => {
    vi.useFakeTimers();
    const { fetch } = mockFetch([{ body: starting }, { body: starting }]);
    const rig = await client(fetch).getRig("dev");
    const wait = rig.wait({ pollMs: 1_000_000 });
    const rejected = expect(wait).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(900_000);
    await rejected;
  });

  it("bounds a stalled HTTP request and aborts it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const { fetch } = mockFetch([{ body: starting }]);
    let first = true;
    const stalled: typeof globalThis.fetch = async (input, init) => {
      if (first) {
        first = false;
        return fetch(input, init);
      }
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    };
    const rig = await client(stalled).getRig("dev");
    const rejected = expect(rig.wait({ maxWaitMs: 20 })).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled token source before any HTTP request", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch([{ body: starting }]);
    const token = vi
      .fn()
      .mockResolvedValueOnce("key")
      .mockImplementation(() => new Promise(() => {}));
    const rig = await new AmikaClient({
      baseUrl: BASE,
      tokenSource: { token },
      fetch,
    }).getRig("dev");
    const rejected = expect(rig.wait({ maxWaitMs: 20 })).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates HTTP errors immediately", async () => {
    const { fetch, calls } = mockFetch([
      { body: starting },
      { status: 401, body: "expired" },
    ]);
    const rig = await client(fetch).getRig("dev");
    await expect(rig.wait()).rejects.toBeInstanceOf(AmikaHTTPError);
    expect(calls).toHaveLength(2);
  });

  it.each([
    { status: [] },
    { status: "invalid" },
    { setupStatus: "failed" },
    { pollMs: 0 },
    { pollMs: NaN },
    { pollMs: 0.5 },
    { maxWaitMs: -1 },
    { maxWaitMs: Infinity },
    { maxWaitMs: 2_147_483_648 },
  ])("rejects invalid wait options before polling: %j", async (options) => {
    const { fetch, calls } = mockFetch([{ body: starting }]);
    const rig = await client(fetch).getRig("dev");
    await expect(rig.wait(options as RigWaitOptions)).rejects.toBeInstanceOf(
      AmikaError,
    );
    expect(calls).toHaveLength(1);
  });
});
