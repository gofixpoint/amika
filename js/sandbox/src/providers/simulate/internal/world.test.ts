import { describe, expect, it } from "vitest";
import { SimulateWorld } from "./world";

function createVm(
  world: SimulateWorld,
  opts: Partial<Parameters<SimulateWorld["createVm"]>[0]> = {},
) {
  return world.createVm({
    name: "vm",
    snapshot: "base",
    services: [],
    ...opts,
  });
}

describe("SimulateWorld clock", () => {
  it("only moves when advanced once frozen", () => {
    const world = new SimulateWorld();
    world.freezeTime(5_000);
    expect(world.now()).toBe(5_000);
    world.advanceTime(1_000);
    expect(world.now()).toBe(6_000);
  });

  it("offsets the wall clock when not frozen", () => {
    const world = new SimulateWorld();
    const before = Date.now();
    world.advanceTime(60_000);
    expect(world.now()).toBeGreaterThanOrEqual(before + 60_000);
  });
});

describe("SimulateWorld auto-stop and auto-delete", () => {
  it("stops a sandbox idle past its auto-stop interval", () => {
    const world = new SimulateWorld();
    world.freezeTime(0);
    const vm = createVm(world, { autoStopInterval: 10 });
    world.advanceTime(9 * 60_000);
    expect(vm.state).toBe("running");
    world.advanceTime(60_000);
    expect(vm.state).toBe("stopped");
    expect(vm.stoppedAt).toBe(10 * 60_000);
  });

  it("counts activity from the last command", () => {
    const world = new SimulateWorld();
    world.freezeTime(0);
    const vm = createVm(world, { autoStopInterval: 10 });
    world.advanceTime(8 * 60_000);
    world.exec(vm.id, "true", undefined);
    world.advanceTime(8 * 60_000);
    expect(vm.state).toBe("running");
    world.advanceTime(2 * 60_000);
    expect(vm.state).toBe("stopped");
  });

  it("deletes a stopped sandbox past its auto-delete interval", () => {
    const world = new SimulateWorld();
    world.freezeTime(0);
    const vm = createVm(world, { autoDeleteInterval: 5 });
    world.stopVm(vm.id);
    world.advanceTime(4 * 60_000);
    expect(world.vm(vm.id)).toBeDefined();
    world.advanceTime(60_000);
    expect(world.vm(vm.id)).toBeUndefined();
  });

  it("never reaps a sandbox with no intervals", () => {
    const world = new SimulateWorld();
    world.freezeTime(0);
    const vm = createVm(world);
    world.advanceTime(365 * 24 * 60 * 60_000);
    expect(vm.state).toBe("running");
  });

  it("lets start override the auto-stop interval", () => {
    const world = new SimulateWorld();
    world.freezeTime(0);
    const vm = createVm(world, { autoStopInterval: 10 });
    world.stopVm(vm.id);
    world.startVm(vm.id, 1);
    world.advanceTime(60_000);
    expect(vm.state).toBe("stopped");
  });
});

describe("SimulateWorld faults", () => {
  it("queues one-shot faults in order ahead of a standing fault", async () => {
    const world = new SimulateWorld();
    world.failNext("list", "first");
    world.failNext("list", "second");
    await expect(world.perform("list", () => 1)).rejects.toThrow("first");
    await expect(world.perform("list", () => 1)).rejects.toThrow("second");
    expect(await world.perform("list", () => 1)).toBe(1);
    world.failAlways("list");
    world.failNext("list", "queued");
    await expect(world.perform("list", () => 1)).rejects.toThrow(
      /Simulated fault in "list"/,
    );
    world.clearFaults();
    expect(await world.perform("list", () => 1)).toBe(1);
  });

  it("delays an operation by its latency", async () => {
    const world = new SimulateWorld();
    world.setLatency("start", 20);
    const started = Date.now();
    await world.perform("start", () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("SimulateWorld snapshots and files", () => {
  it("copies files on capture and on boot, without sharing them", () => {
    const world = new SimulateWorld();
    const source = createVm(world);
    world.writeFile(source.id, "/a", "one");
    world.captureSnapshot(source.id, "snap", true);
    world.writeFile(source.id, "/a", "two");

    const booted = createVm(world, { snapshot: "snap" });
    expect(new TextDecoder().decode(world.readFile(booted.id, "/a")!)).toBe(
      "one",
    );
    world.writeFile(booted.id, "/a", "three");
    expect(
      new TextDecoder().decode(world.snapshot("snap")!.files.get("/a")!),
    ).toBe("one");
  });

  it("stops the source on a cold capture", () => {
    const world = new SimulateWorld();
    const source = createVm(world);
    world.captureSnapshot(source.id, "snap", false);
    expect(source.state).toBe("stopped");
  });

  it("boots from a snapshot's size when the create names none", () => {
    const world = new SimulateWorld();
    const source = createVm(world, {
      resources: { vcpus: 8, memoryGib: 32, diskGib: 100 },
    });
    world.captureSnapshot(source.id, "big", true);
    const booted = createVm(world, { snapshot: "big" });
    expect(booted.resources).toEqual({ vcpus: 8, memoryGib: 32, diskGib: 100 });
  });

  it("reset forgets everything and restarts the id counter", () => {
    const world = new SimulateWorld();
    createVm(world);
    world.onExec("x", { exitCode: 1, stdout: "", stderr: "" });
    world.reset();
    expect(world.vms()).toEqual([]);
    expect(createVm(world).id).toBe("sim-vm-000001");
    expect(world.exec("sim-vm-000001", "x", undefined).exitCode).toBe(0);
  });
});
