/** Cover the embedded runtime over a fake native engine; no VM ever boots. */
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeError,
  embeddedRuntime,
  type ExecResult,
  type NativeEngine,
  type NativeMachine,
  type NativeMachineConfig,
  type NativeMachineSummary,
} from "./smol.js";

const OWNED = { "amika-hostd": "1" };
const OK: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

interface MachineRecord {
  name: string;
  state: string;
  labels: { [key: string]: string };
}

/**
 * An engine over an in-memory machine table. As the real one does, `create`
 * records a stopped machine, `connect` boots a stopped one, and `boot` boots
 * one without returning a handle.
 */
function fakeEngine(initial: MachineRecord[] = []) {
  const machines = new Map(initial.map((m) => [m.name, { ...m }]));
  const handles: ReturnType<typeof handleFor>[] = [];
  function handleFor(record: MachineRecord) {
    return {
      name: record.name,
      state: vi.fn(() => record.state),
      start: vi.fn(async () => void (record.state = "running")),
      stop: vi.fn(async () => void (record.state = "stopped")),
      delete: vi.fn(async () => void machines.delete(record.name)),
      exec: vi.fn(
        async (
          _command: string[],
          _options?: Parameters<NativeMachine["exec"]>[1],
        ) => OK,
      ),
      readFile: vi.fn(async (_path: string) => Buffer.from("contents")),
      writeFile: vi.fn(
        async (
          _path: string,
          _data: Buffer,
          _options?: { mode?: number },
        ) => {},
      ),
    } satisfies NativeMachine;
  }
  const lookup = (name: string) => {
    const record = machines.get(name);
    if (!record) throw new Error(`[NOT_FOUND] machine ${name}`);
    return record;
  };
  const engine = {
    create: vi.fn((config: NativeMachineConfig) => {
      if (machines.has(config.name)) {
        throw new Error(`[CONFLICT] machine ${config.name} exists`);
      }
      const record = {
        name: config.name,
        state: "stopped",
        labels: config.labels,
      };
      machines.set(config.name, record);
      const handle = handleFor(record);
      handles.push(handle);
      return handle;
    }),
    connect: vi.fn((name: string) => {
      const record = lookup(name);
      record.state = "running";
      const handle = handleFor(record);
      handles.push(handle);
      return handle;
    }),
    list: vi.fn(
      async (): Promise<NativeMachineSummary[]> =>
        [...machines.values()].map((m) => ({ ...m })),
    ),
    checkHost: vi.fn(() => ({ available: true as const })),
    boot: vi.fn(async (name: string) => void (lookup(name).state = "running")),
  } satisfies NativeEngine;
  return { engine, machines, handles };
}

/** A runtime over a fake engine, with machines as an earlier daemon left them. */
function harness(initial: MachineRecord[] = []) {
  const fake = fakeEngine(initial);
  return { ...fake, runtime: embeddedRuntime(() => fake.engine) };
}

const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
  fn.mock.invocationCallOrder[0];

describe("embeddedRuntime", () => {
  describe("create", () => {
    it("refuses on a host that cannot run machines, recording nothing", async () => {
      const { runtime, engine } = harness();
      engine.checkHost.mockReturnValue({
        available: false,
        reason: "KVM unavailable",
      } as never);
      await expect(
        runtime.create({ name: "demo", image: "img", network: true }),
      ).rejects.toEqual(new RuntimeError(503, "KVM unavailable"));
      expect(engine.create).not.toHaveBeenCalled();
    });

    it("records a persistent machine with its resources, ports and labels", async () => {
      const { runtime, engine } = harness();
      const info = await runtime.create({
        name: "demo",
        image: "ubuntu:24.04",
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
        network: false,
        env: [{ name: "MODE", value: "test" }],
        ports: [
          { host: 41001, guest: 3000 },
          { host: 41002, guest: 60999 },
        ],
      });
      expect(engine.create).toHaveBeenCalledWith({
        name: "demo",
        image: "ubuntu:24.04",
        env: [{ key: "MODE", value: "test" }],
        ports: [
          { host: 41001, guest: 3000 },
          { host: 41002, guest: 60999 },
        ],
        resources: { cpus: 2, memoryMib: 1024, storageGib: 10, network: false },
        persistent: true,
        labels: {
          "amika-hostd": "1",
          "amika-hostd.cpus": "2",
          "amika-hostd.memory-mb": "1024",
          "amika-hostd.storage-gb": "10",
          "amika-hostd.ports": "41001:3000,41002:60999",
        },
      });
      // Created, not booted.
      expect(info).toEqual({
        name: "demo",
        state: "stopped",
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
        ports: [
          { host: 41001, guest: 3000 },
          { host: 41002, guest: 60999 },
        ],
      });
      expect(engine.boot).not.toHaveBeenCalled();
    });

    it("defaults to smolvm's resources and no ports", async () => {
      const { runtime, engine } = harness();
      const info = await runtime.create({
        name: "demo",
        image: "ubuntu:24.04",
        network: true,
      });
      expect(engine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          env: undefined,
          ports: [],
          resources: {
            cpus: 4,
            memoryMib: 8192,
            storageGib: 20,
            network: true,
          },
          labels: expect.objectContaining({ "amika-hostd.ports": "" }),
        }),
      );
      expect(info).toMatchObject({
        cpus: 4,
        memoryMb: 8192,
        storageGb: 20,
        ports: [],
      });
    });

    it("answers 409 for a name already taken", async () => {
      const { runtime } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await expect(
        runtime.create({ name: "demo", image: "img", network: true }),
      ).rejects.toMatchObject({ name: "RuntimeError", status: 409 });
    });
  });

  describe("list and get", () => {
    const MACHINES: MachineRecord[] = [
      {
        name: "mine",
        state: "running",
        labels: {
          ...OWNED,
          "amika-hostd.cpus": "2",
          "amika-hostd.memory-mb": "2048",
          "amika-hostd.storage-gb": "30",
          "amika-hostd.ports": "41001:3000",
        },
      },
      // Another embedder's machine, sharing the engine's database.
      { name: "theirs", state: "running", labels: { owner: "smol" } },
      // Labels a person edited: each bad one falls back to its default.
      {
        name: "odd",
        state: "stopped",
        labels: {
          ...OWNED,
          "amika-hostd.cpus": "lots",
          "amika-hostd.memory-mb": "-1",
          "amika-hostd.ports": "3000",
        },
      },
    ];

    it("lists only this daemon's machines, described from their labels", async () => {
      const { runtime } = harness(MACHINES);
      expect(await runtime.list()).toEqual([
        {
          name: "mine",
          state: "running",
          cpus: 2,
          memoryMb: 2048,
          storageGb: 30,
          ports: [{ host: 41001, guest: 3000 }],
        },
        {
          name: "odd",
          state: "stopped",
          cpus: 4,
          memoryMb: 8192,
          storageGb: 20,
          ports: [],
        },
      ]);
    });

    it("gets an owned machine without booting it", async () => {
      const { runtime, engine } = harness(MACHINES);
      expect(await runtime.get("odd")).toMatchObject({
        name: "odd",
        state: "stopped",
      });
      expect(engine.boot).not.toHaveBeenCalled();
      expect(engine.connect).not.toHaveBeenCalled();
    });

    it.each(["theirs", "missing"])("answers 404 for %s", async (name) => {
      const { runtime } = harness(MACHINES);
      await expect(runtime.get(name)).rejects.toMatchObject({
        name: "RuntimeError",
        status: 404,
      });
    });

    it("reports a held handle's state over the engine's listing", async () => {
      const { runtime, engine } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      // A listing that lags behind the machine itself.
      engine.list.mockResolvedValue([
        { name: "demo", state: "unknown", labels: OWNED },
      ]);
      expect((await runtime.get("demo")).state).toBe("stopped");
      expect((await runtime.list())[0].state).toBe("stopped");
    });
  });

  describe("start", () => {
    it("starts a held, stopped handle", async () => {
      const { runtime, engine, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      expect((await runtime.start("demo")).state).toBe("running");
      expect(handles[0].start).toHaveBeenCalledTimes(1);
      expect(engine.boot).not.toHaveBeenCalled();
      expect(engine.connect).not.toHaveBeenCalled();
    });

    it("boots a stopped machine from an earlier run on a worker, then attaches", async () => {
      const { runtime, engine, handles } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      expect((await runtime.start("demo")).state).toBe("running");
      expect(engine.boot).toHaveBeenCalledWith("demo");
      expect(engine.connect).toHaveBeenCalledWith("demo");
      expect(order(engine.boot)).toBeLessThan(order(engine.connect));
      expect(handles[0].start).not.toHaveBeenCalled();
      // The handle is kept, so later calls neither boot nor attach again.
      await runtime.start("demo");
      expect(engine.boot).toHaveBeenCalledTimes(1);
      expect(engine.connect).toHaveBeenCalledTimes(1);
    });

    it("attaches to a running machine through the worker, never connecting first", async () => {
      // A listed "running" can be stale; `connect` on the main thread would
      // then boot the machine there, so the worker always goes first.
      const { runtime, engine, handles } = harness([
        { name: "demo", state: "running", labels: OWNED },
      ]);
      await runtime.start("demo");
      expect(order(engine.boot)).toBeLessThan(order(engine.connect));
      expect(handles[0].start).not.toHaveBeenCalled();
    });

    it("boots a machine once for concurrent requests", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await Promise.all([
        runtime.start("demo"),
        runtime.start("demo"),
        runtime.exec("demo", { command: ["true"] }),
      ]);
      expect(engine.boot).toHaveBeenCalledTimes(1);
      expect(engine.connect).toHaveBeenCalledTimes(1);
    });

    it("never attaches after a concurrent delete", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      const removed = runtime.remove("demo");
      await expect(runtime.start("demo")).rejects.toMatchObject({
        status: 404,
      });
      await removed;
      expect(engine.connect).toHaveBeenCalledTimes(1);
    });

    it("answers 503 for a failed boot on a host that cannot run machines", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      engine.boot.mockRejectedValueOnce(
        new Error("[SMOLVM_ERROR] Agent error (start machine): kvm"),
      );
      engine.checkHost.mockReturnValue({
        available: false,
        code: "KVM_UNAVAILABLE",
        reason: "KVM unavailable",
      } as never);
      await expect(runtime.start("demo")).rejects.toEqual(
        new RuntimeError(503, "KVM unavailable"),
      );
    });

    it("answers 404 for a machine it does not own, without booting it", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: {} },
      ]);
      await expect(runtime.start("demo")).rejects.toMatchObject({
        status: 404,
      });
      expect(engine.boot).not.toHaveBeenCalled();
    });

    it("maps a failed boot to its status", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      engine.boot.mockRejectedValueOnce(
        new Error("[KVM_UNAVAILABLE] /dev/kvm missing"),
      );
      await expect(runtime.start("demo")).rejects.toMatchObject({
        status: 503,
      });
      expect(engine.connect).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("does nothing for an already-stopped machine", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      expect((await runtime.stop("demo")).state).toBe("stopped");
      expect(engine.boot).not.toHaveBeenCalled();
      expect(engine.connect).not.toHaveBeenCalled();
    });

    it("does nothing for a held handle already stopped", async () => {
      const { runtime, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      await runtime.stop("demo");
      expect(handles[0].stop).not.toHaveBeenCalled();
    });

    it("stops a held, running handle", async () => {
      const { runtime, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      await runtime.start("demo");
      expect((await runtime.stop("demo")).state).toBe("stopped");
      expect(handles[0].stop).toHaveBeenCalledTimes(1);
    });

    it("attaches to a running machine it holds no handle on to stop it", async () => {
      const { runtime, engine, handles } = harness([
        { name: "demo", state: "running", labels: OWNED },
      ]);
      expect((await runtime.stop("demo")).state).toBe("stopped");
      expect(engine.connect).toHaveBeenCalledWith("demo");
      expect(handles[0].stop).toHaveBeenCalledTimes(1);
    });

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness();
      await expect(runtime.stop("demo")).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("remove", () => {
    it("deletes through a held handle", async () => {
      const { runtime, engine, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      await runtime.remove("demo");
      expect(handles[0].delete).toHaveBeenCalledTimes(1);
      expect(engine.boot).not.toHaveBeenCalled();
      await expect(runtime.get("demo")).rejects.toMatchObject({ status: 404 });
    });

    it("boots a stopped machine from an earlier run to get a handle to delete", async () => {
      const { runtime, engine, handles } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await runtime.remove("demo");
      expect(engine.boot).toHaveBeenCalledWith("demo");
      expect(order(engine.boot)).toBeLessThan(order(engine.connect));
      expect(handles[0].delete).toHaveBeenCalledTimes(1);
      await expect(runtime.get("demo")).rejects.toMatchObject({ status: 404 });
    });

    it("forgets the handle, so a new machine of the same name gets its own", async () => {
      const { runtime, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      await runtime.remove("demo");
      await runtime.create({ name: "demo", image: "img", network: true });
      await runtime.start("demo");
      expect(handles[1].start).toHaveBeenCalled();
      expect(handles[0].start).not.toHaveBeenCalled();
    });

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness();
      await expect(runtime.remove("demo")).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("exec", () => {
    it("starts the machine, then runs the command with env as key/value pairs", async () => {
      const { runtime, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      const [handle] = handles;
      handle.exec.mockResolvedValueOnce({
        exitCode: 3,
        stdout: "out",
        stderr: "err",
      });
      const result = await runtime.exec("demo", {
        command: ["ls", "-la"],
        user: "dev",
        workdir: "/workspace",
        env: [{ name: "A", value: "a b" }],
      });
      expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
      expect(order(handle.start)).toBeLessThan(order(handle.exec));
      expect(handle.exec).toHaveBeenCalledWith(["ls", "-la"], {
        env: [{ key: "A", value: "a b" }],
        workdir: "/workspace",
        user: "dev",
      });
      expect(handle.writeFile).not.toHaveBeenCalled();
    });

    /** A running machine whose `id` reports `ids` for the exec user. */
    async function withStdin(ids: string) {
      const h = harness([{ name: "demo", state: "running", labels: OWNED }]);
      await h.runtime.start("demo");
      const [handle] = h.handles;
      handle.exec.mockImplementation(async (command) => {
        if (command[2] === 'echo "$(id -u):$(id -g)"') {
          return { ...OK, stdout: `${ids}\n` };
        }
        if (command[0] === "/bin/sh") {
          return { exitCode: 0, stdout: "echoed", stderr: "" };
        }
        return OK;
      });
      return { ...h, handle };
    }

    const REQUEST = {
      command: ["cat", "-"],
      stdin: "secret input",
      user: "dev",
      workdir: "/workspace",
      env: [{ name: "A", value: "b" }],
    };

    it("stages stdin in a private guest file, owned by the exec user", async () => {
      const { runtime, handle } = await withStdin("1000:1000");
      expect(await runtime.exec("demo", REQUEST)).toEqual({
        exitCode: 0,
        stdout: "echoed",
        stderr: "",
      });
      const [[file, data, options]] = handle.writeFile.mock.calls;
      expect(file).toMatch(/^\/tmp\/\.amika-hostd-stdin-[0-9a-f-]{36}$/);
      expect(data).toEqual(Buffer.from("secret input"));
      expect(options).toEqual({ mode: 0o600 });
      expect(handle.exec.mock.calls).toEqual([
        [
          ["/bin/sh", "-c", 'echo "$(id -u):$(id -g)"'],
          { env: undefined, workdir: undefined, user: "dev" },
        ],
        [
          ["chown", "1000:1000", file],
          { env: undefined, workdir: undefined, user: "root" },
        ],
        [
          ["/bin/sh", "-c", 'exec "$@" < "$0"', file, "cat", "-"],
          {
            env: [{ key: "A", value: "b" }],
            workdir: "/workspace",
            user: "dev",
          },
        ],
        [
          ["rm", "-f", file],
          { env: undefined, workdir: undefined, user: "root" },
        ],
      ]);
    });

    it("leaves the file root's for a root exec", async () => {
      const { runtime, handle } = await withStdin("0:0");
      await runtime.exec("demo", { ...REQUEST, user: "root" });
      const commands = handle.exec.mock.calls.map(([command]) => command[0]);
      expect(commands).toEqual(["/bin/sh", "/bin/sh", "rm"]);
    });

    it("stages empty stdin too", async () => {
      const { runtime, handle } = await withStdin("0:0");
      await runtime.exec("demo", { command: ["cat"], stdin: "" });
      expect(handle.writeFile.mock.calls[0][1]).toEqual(Buffer.alloc(0));
    });

    it("removes the file even when the command throws", async () => {
      const { runtime, handle } = await withStdin("1000:1000");
      handle.exec.mockImplementation(async (command) => {
        if (command[2] === 'echo "$(id -u):$(id -g)"') {
          return { ...OK, stdout: "1000:1000" };
        }
        if (command[2] === 'exec "$@" < "$0"') {
          throw new Error("[INVALID_STATE] machine stopped");
        }
        return OK;
      });
      await expect(runtime.exec("demo", REQUEST)).rejects.toMatchObject({
        status: 409,
      });
      const file = handle.writeFile.mock.calls[0][0];
      expect(handle.exec.mock.calls.at(-1)?.[0]).toEqual(["rm", "-f", file]);
    });

    it.each([
      ["fails", { exitCode: 1, stdout: "", stderr: "no such user" }],
      ["prints something else", { exitCode: 0, stdout: "dev\n", stderr: "" }],
    ])(
      "refuses to run, and removes the file, when the user lookup %s",
      async (_label, lookup) => {
        const { runtime, handle } = await withStdin("1000:1000");
        handle.exec.mockImplementation(async (command) =>
          command[0] === "/bin/sh" ? lookup : OK,
        );
        await expect(runtime.exec("demo", REQUEST)).rejects.toEqual(
          new RuntimeError(500, "cannot resolve the exec user"),
        );
        const commands = handle.exec.mock.calls.map(([command]) => command[0]);
        expect(commands).toEqual(["/bin/sh", "rm"]);
      },
    );

    it("refuses to run, and removes the file, when chown fails", async () => {
      const { runtime, handle } = await withStdin("1000:1000");
      handle.exec.mockImplementation(async (command) => {
        if (command[2] === 'echo "$(id -u):$(id -g)"') {
          return { ...OK, stdout: "1000:1000" };
        }
        return command[0] === "chown"
          ? { exitCode: 1, stdout: "", stderr: "read-only file system" }
          : OK;
      });
      await expect(runtime.exec("demo", REQUEST)).rejects.toEqual(
        new RuntimeError(500, "cannot hand stdin to the exec user"),
      );
      const commands = handle.exec.mock.calls.map(([command]) => command[0]);
      expect(commands).toEqual(["/bin/sh", "chown", "rm"]);
    });

    it("keeps the command's error when removing the file fails too", async () => {
      const { runtime, handle } = await withStdin("0:0");
      handle.exec.mockImplementation(async (command) => {
        if (command[2] === 'echo "$(id -u):$(id -g)"') {
          return { ...OK, stdout: "0:0" };
        }
        throw new Error("[NOT_FOUND] machine gone");
      });
      await expect(runtime.exec("demo", REQUEST)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("files", () => {
    it("reads and writes through a started machine", async () => {
      const { runtime, handles } = harness();
      await runtime.create({ name: "demo", image: "img", network: true });
      const [handle] = handles;
      expect(await runtime.readFile("demo", "/etc/hostname")).toEqual(
        Buffer.from("contents"),
      );
      expect(handle.start).toHaveBeenCalledTimes(1);
      expect(handle.readFile).toHaveBeenCalledWith("/etc/hostname");
      await runtime.writeFile("demo", "/a b.bin", new Uint8Array([0, 255]));
      expect(handle.writeFile).toHaveBeenCalledWith(
        "/a b.bin",
        Buffer.from([0, 255]),
      );
      // Already running, so not started again.
      expect(handle.start).toHaveBeenCalledTimes(1);
    });

    it("maps a missing guest file to 404", async () => {
      const { runtime, handles } = harness([
        { name: "demo", state: "running", labels: OWNED },
      ]);
      await runtime.start("demo");
      handles[0].readFile.mockRejectedValueOnce(
        new Error("[NOT_FOUND] /nope: no such file"),
      );
      await expect(runtime.readFile("demo", "/nope")).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("errors", () => {
    it.each([
      ["[NOT_FOUND] machine demo", 404],
      ["[CONFLICT] machine demo exists", 409],
      ["[INVALID_STATE] machine demo is stopping", 409],
      ["[CONFIG_ERROR] bad image", 400],
      ["[MOUNT_ERROR] bad mount", 400],
      ["[KVM_UNAVAILABLE] /dev/kvm missing", 503],
      ["[HYPERVISOR_UNAVAILABLE] no hypervisor", 503],
      ["[SOMETHING_NEW] who knows", 500],
      ["no code at all", 500],
      // A code anywhere but the start is not one.
      ["failed: [NOT_FOUND] x", 500],
    ])("maps the native error %j to %i", async (message, status) => {
      const { runtime, engine } = harness();
      engine.list.mockRejectedValueOnce(new Error(message));
      const error = await runtime.list().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({ status, message });
    });

    it("maps a thrown non-Error to 500", async () => {
      const { runtime, engine } = harness();
      engine.list.mockRejectedValueOnce("[NOT_FOUND] as a string");
      // Its text still carries a code.
      await expect(runtime.list()).rejects.toMatchObject({ status: 404 });
      engine.list.mockRejectedValueOnce(42);
      await expect(runtime.list()).rejects.toMatchObject({ status: 500 });
    });

    it("maps a synchronous native failure", async () => {
      const { runtime, engine } = harness([
        { name: "demo", state: "running", labels: OWNED },
      ]);
      engine.connect.mockImplementationOnce(() => {
        throw new Error("[INVALID_STATE] machine is starting");
      });
      await expect(runtime.start("demo")).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe("loading the engine", () => {
    it("loads lazily, once", async () => {
      const { engine } = fakeEngine();
      const load = vi.fn(() => engine);
      const runtime = embeddedRuntime(load);
      expect(load).not.toHaveBeenCalled();
      await runtime.list();
      await runtime.list();
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("answers 503 when the engine cannot load, and tries again next time", async () => {
      const { engine } = fakeEngine();
      const load = vi
        .fn<() => NativeEngine>()
        .mockImplementationOnce(() => {
          throw new Error("cannot load smolmachines");
        })
        .mockReturnValue(engine);
      const runtime = embeddedRuntime(load);
      await expect(runtime.list()).rejects.toEqual(
        new RuntimeError(503, "cannot load smolmachines"),
      );
      await expect(
        runtime.create({ name: "demo", image: "img", network: true }),
      ).resolves.toMatchObject({ name: "demo" });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("stopAll", () => {
    it("stops only the held handles that are not stopped", async () => {
      const { runtime, handles } = harness([
        { name: "running", state: "running", labels: OWNED },
        { name: "idle", state: "running", labels: OWNED },
      ]);
      await runtime.create({ name: "fresh", image: "img", network: true });
      await runtime.start("running");
      await runtime.stop("idle");
      const [fresh, running, idle] = handles;
      handles.forEach((handle) => handle.stop.mockClear());
      await runtime.stopAll();
      expect(running.stop).toHaveBeenCalledTimes(1);
      expect(fresh.stop).not.toHaveBeenCalled();
      expect(idle.stop).not.toHaveBeenCalled();
    });

    it("stops the rest when one fails", async () => {
      const { runtime, handles } = harness([
        { name: "a", state: "running", labels: OWNED },
        { name: "b", state: "running", labels: OWNED },
      ]);
      await runtime.start("a");
      await runtime.start("b");
      handles[0].stop.mockRejectedValueOnce(new Error("[INTERNAL] stuck"));
      await expect(runtime.stopAll()).resolves.toBeUndefined();
      expect(handles[1].stop).toHaveBeenCalled();
    });

    it("stops running machines it holds no handle for, without booting stopped ones", async () => {
      const { runtime, engine, machines } = harness([
        { name: "left", state: "running", labels: OWNED },
        { name: "off", state: "stopped", labels: OWNED },
        { name: "theirs", state: "running", labels: {} },
      ]);
      await runtime.list();
      await runtime.stopAll();
      expect(engine.boot.mock.calls).toEqual([["left"]]);
      expect(machines.get("left")?.state).toBe("stopped");
      expect(machines.get("off")?.state).toBe("stopped");
      expect(machines.get("theirs")?.state).toBe("running");
    });

    it("never loads the engine to stop nothing", async () => {
      const load = vi.fn((): NativeEngine => {
        throw new Error("unavailable");
      });
      await expect(embeddedRuntime(load).stopAll()).resolves.toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    });
  });
});
