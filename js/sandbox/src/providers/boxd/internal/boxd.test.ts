import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCtx } from "../../../logger";

const machines = {
  create: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  wake: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  exec: vi.fn(),
  waitUntilReady: vi.fn(),
  setAutoSuspendTimeout: vi.fn(),
  fs: { write: vi.fn() },
};
const orgs = { getMachineDefaults: vi.fn() };

vi.mock("@boxd-sh/sdk", () => ({
  Boxd: class {
    machines = machines;
    orgs = orgs;
  },
}));

const {
  boxdSizeFor,
  createBoxdSandbox,
  listBoxdSizes,
  mapBoxdSandboxState,
  startBoxdSandbox,
  stopBoxdSandbox,
} = await import("./operations");

const CONFIG = { apiKey: "bxd_test" };
const logger = { info: vi.fn(), warn: vi.fn() };
const ctx = { logger, childCtx: () => ctx } as unknown as SandboxCtx;

beforeEach(() => {
  vi.clearAllMocks();
  machines.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

describe("createBoxdSandbox", () => {
  it("creates an isolated, labeled machine and makes the rig user", async () => {
    machines.create.mockResolvedValue({ id: "vm-1", name: "rig-1" });
    const created = await createBoxdSandbox(ctx, CONFIG, {
      name: "rig-1",
      snapshot: "ubuntu:24.04",
      resources: { vcpus: 4, memoryGib: 16, diskGib: 100 },
      autoStopInterval: 30,
      services: [],
      labels: { "amika-org-id": "org_1", "Bad Key": "x" },
    });
    expect(created.providerSandboxId).toBe("vm-1");
    expect(machines.create).toHaveBeenCalledWith({
      name: "rig-1",
      isolated: true,
      labels: {
        "amika-org-id": "org_1",
        "amika-sandbox-name": "rig-1",
        "amika-create-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        "amika-managed": "true",
      },
      config: { vcpu: 4, memory: "16G", autoSuspendTimeout: 1800 },
    });
    expect(machines.waitUntilReady).toHaveBeenCalledWith("vm-1", {
      timeout: 300_000,
    });
    expect(machines.exec.mock.calls[0][1].command).toMatch(
      /^bash -c .*useradd/s,
    );
  });

  it("finds and deletes a machine whose create answer was lost", async () => {
    machines.create.mockRejectedValue(new Error("connection reset"));
    machines.list.mockResolvedValue([{ id: "vm-lost" }]);
    await expect(
      createBoxdSandbox(ctx, CONFIG, {
        name: "rig-3",
        snapshot: "ubuntu:24.04",
        services: [],
      }),
    ).rejects.toThrow(/connection reset/);
    const createId = machines.create.mock.calls[0][0].labels["amika-create-id"];
    expect(machines.list).toHaveBeenCalledWith({
      labels: { "amika-create-id": createId },
    });
    expect(machines.delete).toHaveBeenCalledWith("vm-lost");
  });

  it("deletes the machine when the rig user cannot be made", async () => {
    machines.create.mockResolvedValue({ id: "vm-2", name: "rig-2" });
    machines.exec.mockResolvedValue({ stdout: "", stderr: "no", exitCode: 1 });
    await expect(
      createBoxdSandbox(ctx, CONFIG, {
        name: "rig-2",
        snapshot: "ubuntu:24.04",
        services: [],
      }),
    ).rejects.toThrow(/amika user/);
    expect(machines.delete).toHaveBeenCalledWith("vm-2");
  });
});

describe("run state", () => {
  it("wakes a sleeping machine on start and before stop", async () => {
    machines.get.mockResolvedValue({ status: "hibernated" });
    await startBoxdSandbox(CONFIG, "vm-1", 0);
    expect(machines.wake).toHaveBeenCalledWith("vm-1");
    expect(machines.setAutoSuspendTimeout).toHaveBeenCalledWith("vm-1", 0);

    vi.clearAllMocks();
    machines.get.mockResolvedValue({ status: "suspended" });
    await stopBoxdSandbox(CONFIG, "vm-1");
    expect(machines.wake).toHaveBeenCalled();
    expect(machines.stop).toHaveBeenCalledWith("vm-1");
  });

  it("flushes the guest's writes before stopping a running machine", async () => {
    machines.get.mockResolvedValue({ status: "running" });
    const order: string[] = [];
    machines.exec.mockImplementation(async () => {
      order.push("sync");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    machines.stop.mockImplementation(async () => {
      order.push("stop");
    });
    await stopBoxdSandbox(CONFIG, "vm-1");
    expect(machines.exec).toHaveBeenCalledWith("vm-1", {
      command: "bash -c 'sync'",
      timeout: 60_000,
    });
    expect(order).toEqual(["sync", "stop"]);
  });

  it("stops even when the flush fails", async () => {
    machines.get.mockResolvedValue({ status: "running" });
    machines.exec.mockRejectedValue(new Error("exec timed out"));
    await stopBoxdSandbox(CONFIG, "vm-1");
    expect(machines.stop).toHaveBeenCalledWith("vm-1");
  });

  it("skips the flush on a machine that is not running", async () => {
    machines.get.mockResolvedValue({ status: "failed" });
    await stopBoxdSandbox(CONFIG, "vm-1");
    expect(machines.exec).not.toHaveBeenCalled();
    expect(machines.stop).toHaveBeenCalledWith("vm-1");

    vi.clearAllMocks();
    machines.get.mockResolvedValue({ status: "stopped" });
    await stopBoxdSandbox(CONFIG, "vm-1");
    expect(machines.exec).not.toHaveBeenCalled();
    expect(machines.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "starting"],
    ["running", "running"],
    ["hibernated", "suspended"],
    ["stopped", "stopped"],
    ["failed", "failed"],
    ["destroyed", "unknown"],
  ])("maps %s to %s", (raw, status) => {
    expect(mapBoxdSandboxState(raw)).toBe(status);
  });
});

describe("sizes", () => {
  it("takes only boxd's classes", () => {
    expect(boxdSizeFor({ vcpus: 2, memoryGib: 8, diskGib: 100 })).toEqual({
      vcpu: 2,
      memory: "8G",
    });
    expect(() => boxdSizeFor({ vcpus: 2, memoryGib: 4, diskGib: 10 })).toThrow(
      /no machine/,
    );
  });

  it("lists the classes under the org's quota", async () => {
    orgs.getMachineDefaults.mockResolvedValue({
      ceilingVcpu: 4,
      ceilingMemoryBytes: 16 * 1024 ** 3,
    });
    expect((await listBoxdSizes(CONFIG)).map((s) => s.vcpus)).toEqual([
      1, 2, 4,
    ]);
  });
});
