/** Cover routing by the machine index, unique names, and `max_running`. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeError,
  type CreateMachine,
  type MachineInfo,
  type MachineRuntime,
} from "./machine-runtime.js";
import {
  fileMachineIndex,
  memoryMachineIndex,
  runtimeRouter,
} from "./runtime-router.js";
import type { RuntimeName } from "./runtimes.js";

/** A runtime holding machines in memory, as a smolvm or Lume would. */
function memoryRuntime(initial: MachineInfo[] = []) {
  const machines = new Map(initial.map((m) => [m.name, m]));
  const find = (name: string) => {
    const machine = machines.get(name);
    if (!machine) throw new RuntimeError(404, `machine ${name} not found`);
    return machine;
  };
  const set = (name: string, state: string) => {
    const machine = { ...find(name), state };
    machines.set(name, machine);
    return machine;
  };
  return {
    machines,
    list: vi.fn(async () => [...machines.values()]),
    get: vi.fn(async (name: string) => find(name)),
    create: vi.fn(async (machine: CreateMachine) => {
      if (machines.has(machine.name)) throw new RuntimeError(409, "exists");
      const created = machineNamed(machine.name, "running");
      machines.set(machine.name, created);
      return created;
    }),
    start: vi.fn(async (name: string) => set(name, "running")),
    stop: vi.fn(async (name: string) => set(name, "stopped")),
    remove: vi.fn(async (name: string) => {
      find(name);
      machines.delete(name);
    }),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    readFile: vi.fn(async () => ({ body: null, contentType: "text/plain" })),
    writeFile: vi.fn(async () => {}),
    checkServices: vi.fn(async () => {}),
    hostPort: vi.fn(async () => 4100),
  } satisfies MachineRuntime & { machines: Map<string, MachineInfo> };
}

function machineNamed(name: string, state = "running"): MachineInfo {
  return { name, state, cpus: 2, memoryMb: 2048, ports: [] };
}

function twoRuntimes(maxRunning: Partial<Record<RuntimeName, number>> = {}) {
  const smol = memoryRuntime([machineNamed("old-smol")]);
  const lume = memoryRuntime();
  const index = memoryMachineIndex();
  const router = runtimeRouter({
    runtimes: { smol, lume },
    maxRunning: () => maxRunning,
    index,
  });
  return { smol, lume, index, router };
}

const create = (name: string, runtime?: RuntimeName): CreateMachine => ({
  name,
  image: "x",
  network: true,
  runtime,
});

describe("runtimeRouter", () => {
  it("creates on the runtime the request names, and routes later calls there", async () => {
    const { router, lume, smol, index } = twoRuntimes();
    expect(await router.create(create("mac", "lume"))).toMatchObject({
      name: "mac",
      runtime: "lume",
    });
    expect(index.get("mac")).toBe("lume");
    await router.stop("mac");
    await router.exec("mac", { command: ["true"] });
    expect(lume.stop).toHaveBeenCalledWith("mac");
    expect(lume.exec).toHaveBeenCalledOnce();
    expect(smol.stop).not.toHaveBeenCalled();
  });

  it("creates on smol when the request names no runtime", async () => {
    const { router, smol } = twoRuntimes();
    await router.create(create("linux"));
    expect(smol.create).toHaveBeenCalledOnce();
  });

  it("lists every runtime's machines, each naming its runtime", async () => {
    const { router } = twoRuntimes();
    await router.create(create("mac", "lume"));
    expect(
      (await router.list()).map((m) => [m.name, m.runtime]).sort(),
    ).toEqual([
      ["mac", "lume"],
      ["old-smol", "smol"],
    ]);
  });

  it("refuses a name a machine on another runtime has", async () => {
    const { router, lume } = twoRuntimes();
    await router.create(create("shared", "smol"));
    await expect(router.create(create("shared", "lume"))).rejects.toMatchObject(
      { status: 409, reason: "a smol machine is named shared" },
    );
    expect(lume.create).not.toHaveBeenCalled();
  });

  it("refuses a runtime that is not on", async () => {
    const smol = memoryRuntime();
    const router = runtimeRouter({
      runtimes: { smol },
      maxRunning: () => ({}),
      index: memoryMachineIndex(),
    });
    await expect(router.create(create("mac", "lume"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("forgets a machine whose create failed and left nothing", async () => {
    const { router, lume, index } = twoRuntimes();
    lume.create.mockRejectedValueOnce(new RuntimeError(500, "boot failed"));
    await expect(router.create(create("mac", "lume"))).rejects.toThrow(
      "boot failed",
    );
    expect(index.get("mac")).toBeUndefined();
  });

  it("forgets a machine once it is deleted, or found to be gone", async () => {
    const { router, lume, index } = twoRuntimes();
    await router.create(create("mac", "lume"));
    await router.remove("mac");
    expect(index.get("mac")).toBeUndefined();
    index.set("gone", "lume");
    await expect(router.remove("gone")).rejects.toMatchObject({ status: 404 });
    expect(index.get("gone")).toBeUndefined();
    expect(lume.remove).toHaveBeenCalledTimes(2);
  });

  it("does not find a machine the index lacks when two runtimes are on", async () => {
    const { router } = twoRuntimes();
    await expect(router.get("old-smol")).rejects.toMatchObject({
      status: 404,
    });
    await router.reconcile();
    expect(await router.get("old-smol")).toMatchObject({ runtime: "smol" });
  });

  it("finds every machine on its one runtime, indexed or not", async () => {
    const smol = memoryRuntime([machineNamed("old-smol")]);
    const router = runtimeRouter({
      runtimes: { smol },
      maxRunning: () => ({}),
      index: memoryMachineIndex(),
    });
    expect(await router.get("old-smol")).toMatchObject({ runtime: "smol" });
    expect(router.runtimeOf("old-smol")).toBe("smol");
  });

  describe("max_running", () => {
    it("refuses a create on a runtime at its limit, as a full host", async () => {
      const { router, lume } = twoRuntimes({ lume: 1 });
      await router.create(create("mac1", "lume"));
      await expect(router.create(create("mac2", "lume"))).rejects.toMatchObject(
        {
          status: 409,
          reason: "host is full: lume runs 1 rig at most, and 1 is running",
        },
      );
      expect(lume.create).toHaveBeenCalledOnce();
      // The limit is per runtime.
      await router.create(create("linux", "smol"));
    });

    it("counts only running machines", async () => {
      const { router } = twoRuntimes({ lume: 1 });
      await router.create(create("mac1", "lume"));
      await router.stop("mac1");
      await router.create(create("mac2", "lume"));
      await expect(router.start("mac1")).rejects.toMatchObject({
        status: 409,
      });
    });

    it("lets a call reach a running machine at the limit, and refuses one that would boot", async () => {
      const { router, lume } = twoRuntimes({ lume: 1 });
      await router.create(create("mac1", "lume"));
      await router.create(create("mac2", "lume")).catch(() => {});
      await router.exec("mac1", { command: ["true"] });
      expect(lume.exec).toHaveBeenCalledOnce();

      await router.stop("mac1");
      lume.machines.set("mac3", machineNamed("mac3", "running"));
      await expect(
        router.exec("mac1", { command: ["true"] }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(router.readFile("mac1", "/x")).rejects.toMatchObject({
        status: 409,
      });
    });
  });
});

describe("fileMachineIndex", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("keeps each machine's runtime across restarts", () => {
    dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-index-"));
    const file = path.join(dir, "machines.json");
    const index = fileMachineIndex(file);
    expect(index.get("mac")).toBeUndefined();
    index.set("mac", "lume");
    index.set("linux", "smol");
    index.remove("linux");
    expect(fileMachineIndex(file).entries()).toEqual([["mac", "lume"]]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      machines: { mac: "lume" },
    });
  });

  it("refuses an index it cannot read, rather than lose track of rigs", () => {
    dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-index-"));
    const file = path.join(dir, "machines.json");
    fileMachineIndex(file).set("mac", "lume");
    expect(() =>
      fileMachineIndex(path.join(dir!, "machines.json", "x")),
    ).toThrow(/Cannot read the machine index/);
  });
});
