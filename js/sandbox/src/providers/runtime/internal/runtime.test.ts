import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCtx } from "../../../logger";
import { send } from "./client";
import { runtimeImageName } from "./names";
import {
  createRuntimeSandbox,
  idlePauseSeconds,
  mapRuntimeSandboxState,
} from "./operations";
import { tokenUrl } from "./services";
import { exitCodeOf, foldEvents } from "./shell";

const CONFIG = { apiKey: "rtkey_test", apiUrl: "https://rt.test" };
const logger = { info: vi.fn(), warn: vi.fn() };
const ctx = { logger, childCtx: () => ctx } as unknown as SandboxCtx;

afterEach(() => vi.unstubAllGlobals());

async function* lines(...events: object[]): AsyncGenerator<string> {
  for (const event of events) yield JSON.stringify(event);
}

function sink() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    stdout: (c: string) => (out.stdout += c),
    stderr: (c: string) => (out.stderr += c),
  };
}

describe("foldEvents", () => {
  it("folds output until exit", async () => {
    const s = sink();
    const end = await foldEvents(
      lines(
        { type: "start", processId: "p1" },
        { type: "stdout", data: "hi" },
        { type: "stderr", data: "warn" },
        { type: "exit", exitCode: 0, state: "exited" },
      ),
      s,
    );
    expect(end).toEqual({ kind: "exit", exitCode: 0 });
    expect(s.out).toEqual({ stdout: "hi", stderr: "warn" });
  });

  it("hands back a cut stream's process and cursor", async () => {
    expect(
      await foldEvents(
        lines({ type: "continue", processId: "p1", cursor: 42 }),
        sink(),
      ),
    ).toEqual({ kind: "continue", processId: "p1", cursor: 42 });
  });

  it("throws on an error event", async () => {
    await expect(
      foldEvents(lines({ type: "error", error: { code: "internal" } }), sink()),
    ).rejects.toThrow(/internal/);
  });
});

describe("exitCodeOf", () => {
  it("maps time outs to 124 and signals to 128 + n", () => {
    expect(exitCodeOf({ exitCode: 3 })).toBe(3);
    expect(exitCodeOf({ exitCode: null, timedOut: true })).toBe(124);
    expect(exitCodeOf({ state: "timed_out" })).toBe(124);
    expect(exitCodeOf({ exitCode: -9 })).toBe(137);
  });
});

describe("mappings", () => {
  it("maps idle minutes to Runtime's bounds", () => {
    expect(idlePauseSeconds(undefined)).toBeUndefined();
    expect(idlePauseSeconds(0)).toBe(0);
    expect(idlePauseSeconds(0.5)).toBe(60);
    expect(idlePauseSeconds(30)).toBe(1800);
    expect(idlePauseSeconds(100_000)).toBe(86_400);
  });

  it("reads a pause as stopped", () => {
    expect(mapRuntimeSandboxState("paused")).toBe("stopped");
    expect(mapRuntimeSandboxState("error")).toBe("failed");
    expect(mapRuntimeSandboxState("deleted")).toBe("unknown");
  });

  it("maps image names to Runtime's rules", () => {
    expect(runtimeImageName("base.v1")).toBe("base.v1");
    expect(runtimeImageName("Org/Snap 1")).toMatch(/^[a-z0-9._-]{1,64}$/);
  });

  it("puts the preview token in the query", () => {
    expect(tokenUrl("https://3000-abc.rt.dev/", "t0k")).toBe(
      "https://3000-abc.rt.dev/?runtime_preview_token=t0k",
    );
  });
});

describe("send", () => {
  it("refuses a key-pair key before any request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(send({ apiKey: "rtsk_abc" }, "GET", "/me")).rejects.toThrow(
      /bearer API key/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the version and an idempotency key on a POST", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await send(CONFIG, "POST", "/sandboxes", { json: {} });
    const headers = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers["Runtime-Version"]).toBe("2026-10-27");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("createRuntimeSandbox", () => {
  it("creates with labels and size, then makes the rig user", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({
          url,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url.endsWith("/v2/sandboxes")) {
          return new Response(
            JSON.stringify({ id: "sbx_1", state: "running", labels: {} }),
          );
        }
        if (url.endsWith(":exec")) {
          return new Response(
            `${JSON.stringify({ type: "exit", exitCode: 0 })}\n`,
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const created = await createRuntimeSandbox(ctx, CONFIG, {
      name: "rig--sbx_9",
      snapshot: "runtime",
      resources: { vcpus: 4, memoryGib: 8, diskGib: 24 },
      autoStopInterval: 15,
      services: [],
    });
    expect(created.providerSandboxId).toBe("sbx_1");
    expect(requests[0].body).toMatchObject({
      vcpu: 4,
      memoryGB: 8,
      diskGB: 24,
      idlePauseSeconds: 900,
      user: "runtime",
      labels: { "amika-sandbox-name": "rig--sbx_9", "amika-managed": "true" },
    });
    expect(requests[0].body).not.toHaveProperty("image");
    const exec = requests[1].body as { cmd: string[] };
    expect(exec.cmd.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(exec.cmd[2]).toContain("useradd");
  });
});
