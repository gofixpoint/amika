import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../../logger";
import { BoatApiError, send } from "./client";
import { boatSnapshotName } from "./names";
import {
  boatTypeFor,
  createBoatSandbox,
  mapBoatSandboxState,
} from "./operations";
import { collectFrames, exitCodeOf } from "./shell";

const CONFIG = { apiKey: "boat_test", apiUrl: "https://boat.test/api/v1" };
const logger = moduleLogger({ test: "boat" });
const ctx = { logger, childCtx: () => ctx } as unknown as SandboxCtx;

afterEach(() => vi.unstubAllGlobals());

async function* lines(...frames: object[]): AsyncGenerator<string> {
  for (const frame of frames) yield JSON.stringify(frame);
}

describe("collectFrames", () => {
  it("collects stdout and stderr apart until exit", async () => {
    expect(
      await collectFrames(
        lines(
          { type: "started", commandId: "cmd_1" },
          { type: "stdout", data: "a" },
          { type: "stderr", data: "e" },
          { type: "stdout", data: "b" },
          { type: "exit", exitCode: 2, success: false, timedOut: false },
        ),
      ),
    ).toEqual({ exitCode: 2, stdout: "ab", stderr: "e" });
  });

  it("reports a timed-out command as 124", async () => {
    const result = await collectFrames(
      lines({ type: "exit", exitCode: null, timedOut: true }),
    );
    expect(result.exitCode).toBe(124);
  });

  it("reports a signal, not a time out, for a killed command", () => {
    expect(exitCodeOf({ exitCode: null, signal: "SIGTERM" })).toBe(143);
    expect(exitCodeOf({ exitCode: null, oomKilled: true })).toBe(137);
    expect(exitCodeOf({ exitCode: 0, timedOut: false })).toBe(0);
  });

  it("throws on an error frame or a stream with no exit", async () => {
    await expect(
      collectFrames(lines({ type: "error", error: "boom", message: "bad" })),
    ).rejects.toBeInstanceOf(BoatApiError);
    await expect(
      collectFrames(lines({ type: "stdout", data: "x" })),
    ).rejects.toThrow(/without an exit frame/);
  });
});

describe("sizes, states, names", () => {
  it("maps sizes to boat's four types and refuses others", () => {
    expect(boatTypeFor({ vcpus: 4, memoryGib: 8, diskGib: 20 })).toBe(
      "default",
    );
    expect(boatTypeFor({ vcpus: 16, memoryGib: 32, diskGib: 40 })).toBe(
      "xlarge",
    );
    expect(() =>
      boatTypeFor({ vcpus: 16, memoryGib: 24, diskGib: 40 }),
    ).toThrow(/no machine type/);
  });

  it.each([
    ["provisioning", "starting"],
    ["idle", "running"],
    ["archiving", "stopping"],
    ["archived", "stopped"],
    ["error", "failed"],
    ["mystery", "unknown"],
  ])("maps %s to %s", (raw, status) => {
    expect(mapBoatSandboxState(raw)).toBe(status);
  });

  it("maps snapshot names to boat's rules, never to a reserved word", () => {
    expect(boatSnapshotName("base-1")).toBe("base-1");
    expect(boatSnapshotName("latest")).not.toBe("latest");
    expect(boatSnapshotName("org_1/My Snap")).toMatch(
      /^[a-z0-9][a-z0-9-]{0,62}$/,
    );
  });
});

describe("send", () => {
  it("retries a command refused while the sandbox starts", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response(
              JSON.stringify({
                ok: false,
                code: "sandbox_starting",
                error: { code: "sandbox_starting", message: "wait" },
                retryAfterSeconds: 0,
              }),
              { status: 409 },
            )
          : new Response("{}");
      }),
    );
    await send(CONFIG, "POST", "/sandboxes/bx_1/commands", { json: {} });
    expect(calls).toBe(2);
  });

  it("does not retry a command after an error that may have run it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: "internal", message: "x" },
              retryable: true,
            }),
            { status: 500 },
          ),
      ),
    );
    await expect(
      send(CONFIG, "POST", "/sandboxes/bx_1/commands", { json: {} }),
    ).rejects.toMatchObject({ status: 500 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("createBoatSandbox", () => {
  it("creates with no env, no deadline and no monitoring, waits, and makes the rig user", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method: init.method ?? "GET", url, body });
        if (init.method === "POST" && url.endsWith("/sandboxes")) {
          return new Response(
            JSON.stringify({
              sandbox: { id: "bx_1", name: "n", state: "provisioning" },
            }),
            { status: 202 },
          );
        }
        if (url.endsWith("/sandboxes/bx_1")) {
          return new Response(
            JSON.stringify({
              sandbox: { id: "bx_1", name: "n", state: "ready" },
            }),
          );
        }
        if (url.endsWith("/commands")) {
          return new Response(
            `${JSON.stringify({ type: "exit", exitCode: 0 })}\n`,
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const created = await createBoatSandbox(ctx, CONFIG, {
      name: "rig--sbx_1",
      snapshot: "ubuntu-24.04",
      resources: { vcpus: 2, memoryGib: 4, diskGib: 20 },
      services: [],
      labels: { "amika-org-id": "org_1" },
    });
    expect(created.providerSandboxId).toBe("bx_1");
    const create = requests[0].body as Record<string, unknown>;
    expect(create).toMatchObject({
      name: "rig--sbx_1",
      noEnv: true,
      monitoring: false,
      ttlSeconds: null,
      type: "small",
      labels: {
        "amika-org-id": "org_1",
        "amika-sandbox-name": "rig--sbx_1",
        "amika-managed": "true",
      },
    });
    expect(create).not.toHaveProperty("from");
    const command = requests.find((r) => r.url.endsWith("/commands"));
    expect((command?.body as { command: string }).command).toMatch(
      /^bash -c .*useradd/s,
    );
  });
});
