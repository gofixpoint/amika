import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCtx } from "../../../logger";
import { orbleBoxName } from "./names";
import {
  createOrbleSandbox,
  mapOrbleSandboxState,
  orbleSizeFor,
} from "./operations";
import { orbleShell, readOrbleFile, runOrbleScript } from "./shell";

const CONFIG = { apiKey: "orble_test", apiUrl: "https://orble.test" };
const logger = { info: vi.fn(), warn: vi.fn() };
const ctx = { logger, childCtx: () => ctx } as unknown as SandboxCtx;

afterEach(() => vi.unstubAllGlobals());

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = {
        method: init.method ?? "GET",
        url,
        body:
          init.body instanceof Uint8Array
            ? init.body
            : init.body
              ? JSON.parse(String(init.body))
              : undefined,
      };
      calls.push(call);
      return new Response(JSON.stringify(answer(call)));
    }),
  );
  return calls;
}

describe("runOrbleScript", () => {
  it("follows a long command's job until it ends", async () => {
    const answers = [
      { running: true, job: "j1", stdout: "a", stderr: "" },
      { running: false, exit_code: 0, stdout: "ab", stderr: "" },
    ];
    const calls = stubFetch(() => answers.shift());
    expect(await runOrbleScript(CONFIG, "box-1", "echo hi")).toEqual({
      exitCode: 0,
      stdout: "ab",
      stderr: "",
    });
    expect(calls[0].body).toEqual({
      command: "bash -c 'echo hi'",
      timeout_s: 600,
    });
    expect(calls[1].body).toEqual({ job: "j1" });
  });

  it("reports a timed-out command as 124", async () => {
    stubFetch(() => ({ exit_code: 124, timed_out: true }));
    expect((await runOrbleScript(CONFIG, "b", "sleep 999")).exitCode).toBe(124);
  });
});

describe("files", () => {
  it("reads a file chunk by chunk in either encoding", async () => {
    const chunks = [
      { size: 6, offset: 0, bytes: 3, encoding: "utf-8", content: "abc" },
      {
        size: 6,
        offset: 3,
        bytes: 3,
        encoding: "base64",
        content: Buffer.from([0, 255, 10]).toString("base64"),
      },
    ];
    const calls = stubFetch(() => chunks.shift());
    const bytes = await readOrbleFile(CONFIG, "b", "/x");
    expect(Buffer.from(bytes)).toEqual(
      Buffer.concat([Buffer.from("abc"), Buffer.from([0, 255, 10])]),
    );
    expect(new URL(calls[1].url).searchParams.get("offset")).toBe("3");
  });

  it("stages a large file in parts and joins them", async () => {
    const calls = stubFetch((call) =>
      call.method === "PUT" ? { bytes: 1 } : { exit_code: 0 },
    );
    const big = new Uint8Array(15 * 1024 * 1024);
    await orbleShell(CONFIG, "b").stage("/s/f", big);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(3);
    expect(new URL(puts[2].url).searchParams.get("path")).toBe(
      "/s/f.part-0002",
    );
    const join = calls.find((c) => c.method === "POST")?.body as {
      command: string;
    };
    expect(join.command).toContain("/s/f.part-0000");
  });
});

describe("sizes, states, names", () => {
  it("maps sizes to s, m, l and refuses others", () => {
    expect(orbleSizeFor({ vcpus: 4, memoryGib: 8, diskGib: 20 })).toBe("m");
    expect(() =>
      orbleSizeFor({ vcpus: 16, memoryGib: 32, diskGib: 40 }),
    ).toThrow(/no size/);
  });

  it("keeps suspended apart from stopped", () => {
    expect(mapOrbleSandboxState("suspended")).toBe("suspended");
    expect(mapOrbleSandboxState("running")).toBe("running");
  });

  it("makes box names Orble's API takes: 2 to 32 of a-z, 0-9, -", () => {
    const valid = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
    expect(orbleBoxName("rig-1")).toBe("rig-1");
    expect(orbleBoxName("My Rig--sbx_1")).toMatch(valid);
    expect(orbleBoxName("a")).toMatch(valid);
    // The name Amika sends for a rig: `<rig>--<rig id>`.
    const rigName = "byoc-orble--baa2af16-13fc-42b7-9952-ead9bb55826e";
    expect(orbleBoxName(rigName)).toMatch(valid);
    expect(orbleBoxName(rigName)).not.toBe(
      orbleBoxName("byoc-orble--baa2af16-13fc-42b7-9952-ead9bb55826f"),
    );
  });
});

describe("createOrbleSandbox", () => {
  it("creates by name and size, keeps awake for 0, and makes the rig user", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/exec")
        ? { exit_code: 0 }
        : { name: "rig-1", state: "running" },
    );
    const created = await createOrbleSandbox(ctx, CONFIG, {
      name: "rig-1",
      snapshot: "debian-13",
      resources: { vcpus: 2, memoryGib: 4, diskGib: 20 },
      autoStopInterval: 0,
      services: [],
    });
    expect(created.providerSandboxId).toBe("rig-1");
    expect(calls[0].body).toEqual({ name: "rig-1", size: "s" });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      body: { keep_awake: true },
    });
    expect((calls[2].body as { command: string }).command).toContain("useradd");
  });
});
