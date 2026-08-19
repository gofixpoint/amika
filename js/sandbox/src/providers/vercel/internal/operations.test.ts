import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SandboxCtx } from "../../../logger";
import type { VercelConfig } from "../config";
import type {
  CreateSandboxProviderInput,
  SandboxService,
} from "../../provider";
import {
  createVercelSandbox,
  executeVercelCommand,
  listVercelSandboxes,
  resolveVercelBootSource,
  resolveVercelPorts,
  portsForDesiredServices,
  vercelTimeoutMs,
  mapVercelSandboxState,
  writeVercelFile,
  writeVercelResumeContext,
  VERCEL_RESUME_CONTEXT_PATH,
} from "./operations";
import { AMIKAD_ETC_DIR, SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";

/**
 * In-memory {@link SandboxAdapter} recorder: captures uploads into `files` and
 * every exec (with its sudo flag) into `commands`, so tests can assert what was
 * written and run without a provider.
 */
class FakeAdapter implements SandboxAdapter {
  readonly files = new Map<string, string>();
  readonly commands: { command: string; sudo: boolean }[] = [];

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.commands.push({ command, sudo: opts?.sudo ?? false });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async uploadFile(content: Buffer | string, filePath: string): Promise<void> {
    this.files.set(
      filePath,
      typeof content === "string" ? content : content.toString("utf8"),
    );
  }

  async downloadFile(filePath: string): Promise<string | null> {
    return this.files.get(filePath) ?? null;
  }
}

const sandboxCreate = vi.fn();
const sandboxGet = vi.fn();
const sandboxList = vi.fn();
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: (...args: unknown[]) => sandboxCreate(...args),
    get: (...args: unknown[]) => sandboxGet(...args),
    list: (...args: unknown[]) => sandboxList(...args),
  },
}));

const VERCEL_CONFIG: VercelConfig = {
  apiKey: "tok",
  teamId: "team_1",
  projectId: "prj_1",
};

/** A mock sandbox whose `runCommand` returns fixed output. */
function mockSandbox(update = vi.fn(async () => {})) {
  return {
    update,
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "out",
      stderr: async () => "",
    })),
  };
}

function service(name: string, containerPort: number): SandboxService {
  return {
    name,
    url: "",
    hostPort: containerPort,
    containerPort,
    protocol: "tcp",
  };
}

describe("resolveVercelBootSource", () => {
  it("returns a captured snapshot source for a snapshot id", () => {
    expect(resolveVercelBootSource("snap_abc123")).toEqual({
      source: { type: "snapshot", snapshotId: "snap_abc123" },
    });
  });

  it("returns an image source for a fully qualified VCR reference", () => {
    const image = "vcr.vercel.com/fixpoint/amika/sandbox-coder:v1";
    expect(resolveVercelBootSource(image)).toEqual({ image });
  });

  it("throws when no prepared source is configured", () => {
    expect(() => resolveVercelBootSource("")).toThrow(
      /require a prepared VCR image or captured snapshot/,
    );
    expect(() => resolveVercelBootSource(undefined)).toThrow(
      /require a prepared VCR image or captured snapshot/,
    );
  });

  it("throws for a runtime name rather than booting a plain runtime", () => {
    // A plain runtime lacks the baked-in amikad hooks + agent tooling, so it
    // cannot boot an Amika sandbox — reject rather than degrade.
    expect(() => resolveVercelBootSource("python3.13")).toThrow(
      /require a prepared VCR image or captured snapshot/,
    );
  });

  it("throws for a foreign snapshot value (e.g. a Daytona image tag)", () => {
    // A Daytona-style image tag sent after switching providers is not a Vercel
    // snapshot id.
    expect(() => resolveVercelBootSource("amika/daytona-coder-m:abc")).toThrow(
      /require a prepared VCR image or captured snapshot/,
    );
  });
});

describe("resolveVercelPorts", () => {
  it("keeps the Coding Agent port first and dedupes", () => {
    const ports = resolveVercelPorts([
      service("web", 3000),
      service("Coding Agent", 60998),
      service("web", 3000),
    ]);
    expect(ports).toEqual([60998, 3000]);
  });

  it("caps the exposed ports at the Vercel limit (15), dropping extras after the agent", () => {
    // 1 agent + 16 services = 17 requested, two over the platform limit of 15.
    const extras = Array.from({ length: 16 }, (_, i) =>
      service(`svc-${i}`, 3001 + i),
    );
    const ports = resolveVercelPorts([
      service("Coding Agent", 60998),
      ...extras,
    ]);
    expect(ports).toHaveLength(15);
    expect(ports[0]).toBe(60998);
    // The last two requested ports are the ones dropped.
    expect(ports).not.toContain(3015);
    expect(ports).not.toContain(3016);
  });
});

describe("portsForDesiredServices", () => {
  it("drops a removed service's port and the legacy SSH bridge route", () => {
    // Live routes on an older sandbox still carry the legacy `websocat` SSH
    // bridge (2222); the desired set no longer contains port 3000, so the
    // reconciled list drops both the removed service and the defunct bridge.
    expect(
      portsForDesiredServices(
        [60998, 3000, 2222],
        [service("Coding Agent", 60998)],
      ),
    ).toEqual([60998]);
  });

  it("strips the legacy SSH bridge route while keeping surviving services", () => {
    // Migration case: an older sandbox exposes a live service port (3000)
    // alongside the legacy bridge (2222). Reconciling to the still-desired
    // services keeps 3000 and tears down 2222.
    expect(
      portsForDesiredServices(
        [60998, 3000, 2222],
        [service("Coding Agent", 60998), service("web", 3000)],
      ),
    ).toEqual([60998, 3000]);
  });

  it("is a no-op when a surviving service still uses the port", () => {
    expect(
      portsForDesiredServices(
        [60998, 3000],
        [service("Coding Agent", 60998), service("other", 3000)],
      ),
    ).toBeNull();
  });

  it("exposes a late-added service port (KAPRO-616)", () => {
    // A service added after create is not exposed by the base port logic; the
    // declarative reconcile adds it.
    expect(
      portsForDesiredServices(
        [60998],
        [service("Coding Agent", 60998), service("late", 4000)],
      ),
    ).toEqual([60998, 4000]);
  });

  it("is a no-op when the port set already matches (order-insensitive)", () => {
    expect(
      portsForDesiredServices(
        [3000, 60998],
        [service("Coding Agent", 60998), service("web", 3000)],
      ),
    ).toBeNull();
  });

  it("drops the legacy SSH bridge route even when the desired set fills all 15", () => {
    // 15 desired service ports fill the cap; the live 2222 bridge route is not
    // part of the desired set, so it is torn down (as it always is now).
    const desired = Array.from({ length: 15 }, (_, i) =>
      service(`svc-${i}`, 3000 + i),
    );
    const next = portsForDesiredServices([60998, 2222], desired);
    expect(next).toHaveLength(15);
    expect(next).not.toContain(2222);
  });
});

describe("vercelTimeoutMs", () => {
  it("maps a positive interval (minutes) to milliseconds", () => {
    expect(vercelTimeoutMs(10)).toBe(10 * 60_000);
  });

  it("clamps an over-ceiling interval", () => {
    expect(vercelTimeoutMs(600)).toBe(45 * 60_000);
  });

  it("uses the default window for never (0) and absent", () => {
    expect(vercelTimeoutMs(0)).toBe(45 * 60_000);
    expect(vercelTimeoutMs(null)).toBe(45 * 60_000);
    expect(vercelTimeoutMs(undefined)).toBe(45 * 60_000);
  });
});

describe("createVercelSandbox", () => {
  const config: VercelConfig = {
    apiKey: "tok",
    teamId: "team_1",
    projectId: "prj_1",
  };

  function ctx(): SandboxCtx {
    return { logger: pino({ enabled: false }), childCtx: () => ctx() };
  }

  function createInput(
    overrides?: Partial<CreateSandboxProviderInput>,
  ): CreateSandboxProviderInput {
    return {
      name: "sbx",
      snapshot: "snap_test",
      services: [],
      ...overrides,
    };
  }

  beforeEach(() => sandboxCreate.mockReset());

  it("boots a persistent sandbox from a VCR image", async () => {
    sandboxCreate.mockResolvedValue({ name: "vercel-generated" });

    const image = "vcr.vercel.com/fixpoint/amika/sandbox-coder:v1";
    const result = await createVercelSandbox(
      ctx(),
      config,
      createInput({ snapshot: image }),
    );

    expect(sandboxCreate).toHaveBeenCalledTimes(1);
    // Persistence auto-snapshots on stop; without a retention policy the
    // snapshots accumulate and inherit Vercel's default 30-day expiry (a
    // dormant sandbox would lose its resumable state).
    expect(sandboxCreate.mock.calls[0][0]).toMatchObject({
      persistent: true,
      keepLastSnapshots: { count: 1 },
      snapshotExpiration: 0,
      image,
    });
    expect(result.provider).toBe("vercel");
    expect(result.providerSandboxId).toBe("vercel-generated");
  });

  it("boots a captured user snapshot by id", async () => {
    sandboxCreate.mockResolvedValue({ name: "vercel-generated" });

    await createVercelSandbox(ctx(), config, createInput());

    expect(sandboxCreate.mock.calls[0][0]).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap_test" },
    });
  });

  it("passes literal caller resources to Vercel", async () => {
    sandboxCreate.mockResolvedValue({ name: "vercel-generated" });

    await createVercelSandbox(
      ctx(),
      config,
      createInput({
        resources: { vcpus: 6, memoryGib: 12, diskGib: 32 },
      }),
    );

    expect(sandboxCreate.mock.calls[0][0]).toMatchObject({
      resources: { vcpus: 6 },
    });
  });
});

describe("mapVercelSandboxState", () => {
  it("maps every raw Vercel status onto the canonical vocabulary", () => {
    const cases: Record<string, string> = {
      pending: "starting",
      running: "running",
      snapshotting: "snapshotting",
      stopping: "stopping",
      stopped: "suspended",
      failed: "failed",
      aborted: "failed",
    };
    for (const [raw, expected] of Object.entries(cases)) {
      expect(mapVercelSandboxState(raw), raw).toBe(expected);
    }
  });

  it("maps the synthesized missing-sandbox sentinel and junk to unknown", () => {
    expect(mapVercelSandboxState("unknown")).toBe("unknown");
    expect(mapVercelSandboxState("")).toBe("unknown");
  });
});

describe("executeVercelCommand", () => {
  beforeEach(() => sandboxGet.mockReset());

  it("resumes and restarts lifecycle services by default", async () => {
    sandboxGet.mockResolvedValue(mockSandbox());

    const result = await executeVercelCommand(
      VERCEL_CONFIG,
      "sandbox-name",
      "echo hi",
    );

    // Default cold-resume behavior wires an `onResume` hook (service restart)
    // and resumes the sandbox by its provider id.
    expect(sandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sandbox-name",
        resume: true,
        onResume: expect.any(Function),
      }),
    );
    expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "" });
  });

  it('skips the service restart when resumeMode is "bare"', async () => {
    sandboxGet.mockResolvedValue(mockSandbox());

    await executeVercelCommand(VERCEL_CONFIG, "sandbox-name", "echo hi", {
      resumeMode: "bare",
    });

    // `bare` resumes only the filesystem — no `onResume` hook, so a plain
    // command (agent launch / exit probe) doesn't pay the relaunch latency.
    const arg = sandboxGet.mock.calls[0][0] as { onResume?: unknown };
    expect(arg.onResume).toBeUndefined();
  });

  it("reapplies the session timeout before running when requested", async () => {
    const calls: string[] = [];
    const update = vi.fn(async () => {
      calls.push("update");
    });
    const sandbox = mockSandbox(update);
    sandbox.runCommand = vi.fn(async () => {
      calls.push("runCommand");
      return { exitCode: 0, stdout: async () => "out", stderr: async () => "" };
    });
    sandboxGet.mockResolvedValue(sandbox);

    await executeVercelCommand(VERCEL_CONFIG, "sandbox-name", "echo hi", {
      sessionTimeoutMs: 45 * 60 * 1000,
    });

    // The timeout must be reapplied *before* the command runs so a resumed
    // sandbox isn't suspended mid-run.
    expect(update).toHaveBeenCalledWith({ timeout: 45 * 60 * 1000 });
    expect(calls).toEqual(["update", "runCommand"]);
  });

  it("does not touch the timeout when sessionTimeoutMs is omitted", async () => {
    const sandbox = mockSandbox();
    sandboxGet.mockResolvedValue(sandbox);

    await executeVercelCommand(VERCEL_CONFIG, "sandbox-name", "echo hi");

    expect(sandbox.update).not.toHaveBeenCalled();
  });
});

describe("listVercelSandboxes", () => {
  beforeEach(() => sandboxList.mockReset());

  function mockList(items: unknown[]): void {
    sandboxList.mockResolvedValue({ toArray: async () => items });
  }

  it("maps each sandbox to its org (from tags), status, and derived sizing", async () => {
    mockList([
      {
        name: "sbx-1",
        tags: { [SANDBOX_ORG_ID_LABEL]: "org_abc" },
        vcpus: 4,
        status: "running",
      },
    ]);

    const listings = await listVercelSandboxes(VERCEL_CONFIG);

    expect(listings).toEqual([
      {
        providerSandboxId: "sbx-1",
        orgId: "org_abc",
        state: "running",
        // Vercel couples 2 GB/vCPU and a fixed 32 GB ephemeral disk.
        sizing: { vcpus: 4, memoryGib: 8, diskGib: 32 },
      },
    ]);
  });

  it("reports a null org for a sandbox with no org tag", async () => {
    mockList([{ name: "sbx-1", tags: {}, vcpus: 2, status: "running" }]);

    expect((await listVercelSandboxes(VERCEL_CONFIG))[0]?.orgId).toBeNull();
  });

  it("skips sandboxes with no reported vCPU count", async () => {
    mockList([
      { name: "sbx-sized", tags: {}, vcpus: 2, status: "running" },
      { name: "sbx-unsized", tags: {}, vcpus: null, status: "running" },
    ]);

    const ids = (await listVercelSandboxes(VERCEL_CONFIG)).map(
      (l) => l.providerSandboxId,
    );
    expect(ids).toEqual(["sbx-sized"]);
  });
});

describe("writeVercelFile", () => {
  beforeEach(() => sandboxGet.mockReset());

  it("writes content to the path via the sandbox (args not swapped)", async () => {
    const writeFiles = vi.fn(async () => {});
    sandboxGet.mockResolvedValue({
      // ensureParentDir runs a best-effort `mkdir -p` before the write.
      runCommand: vi.fn(async () => ({})),
      writeFiles,
    });

    await writeVercelFile(VERCEL_CONFIG, "sbx", "/home/amika/f.txt", "hello");

    expect(writeFiles).toHaveBeenCalledWith([
      { path: "/home/amika/f.txt", content: Buffer.from("hello", "utf8") },
    ]);
  });
});

describe("writeVercelResumeContext", () => {
  const context = {
    openCodePassword: "pw",
    amikaOpenCodeWeb: "http://box:60998",
    repoDir: "/home/amika/workspace/amika",
  };

  it("uploads the context as JSON to a temp file", async () => {
    const adapter = new FakeAdapter();
    await writeVercelResumeContext(adapter, context);

    expect(adapter.files.size).toBe(1);
    const [tempPath, content] = [...adapter.files.entries()][0];
    expect(tempPath).toMatch(/^\/tmp\/amika-vercel-resume-.*\.json$/);
    expect(JSON.parse(content)).toEqual(context);
  });

  it("installs the file to the resume-context path and cleans up, all as root", async () => {
    const adapter = new FakeAdapter();
    await writeVercelResumeContext(adapter, context);

    const [tempPath] = [...adapter.files.keys()];
    expect(adapter.commands).toEqual([
      { command: `mkdir -p '${AMIKAD_ETC_DIR}'`, sudo: true },
      {
        command: `install -m 0600 '${tempPath}' '${VERCEL_RESUME_CONTEXT_PATH}'`,
        sudo: true,
      },
      { command: `rm -f '${tempPath}'`, sudo: true },
    ]);
  });
});
