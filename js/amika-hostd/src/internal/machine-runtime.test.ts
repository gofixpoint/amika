/**
 * Cover the runtime over the `smolvm-sdk` provider, itself over a fake
 * `smolmachines` SDK; no VM ever boots.
 */
import { describe, expect, it, vi } from "vitest";
import type { MachineConfig, MachineSummary } from "smolmachines";
import type { SmolMachine, SmolMachines } from "@amika/sandbox/smolvm-sdk";
import {
  RuntimeError,
  providerRuntime,
  type ExecResult,
} from "./machine-runtime.js";

/** The label the provider marks its own machines with. */
const OWNED = { "amika-smolvm-sdk": "1" };
const OK: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const LOCAL = { target: "local", handleSignals: false };

interface MachineRecord {
  name: string;
  state: string;
  labels: Record<string, string>;
}

/** An SDK error, as `SmolError` carries it. */
function smolError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * An SDK over an in-memory machine table. As the real one does, `create`
 * and `connect` boot the machine, and `list` filters by label.
 */
function fakeSdk(initial: MachineRecord[] = []) {
  const machines = new Map(initial.map((m) => [m.name, { ...m }]));
  const handles = new Map<string, ReturnType<typeof handleFor>>();
  function handleFor(record: MachineRecord) {
    return {
      start: vi.fn(async () => void (record.state = "running")),
      resume: vi.fn(async () => void (record.state = "running")),
      stop: vi.fn(async () => void (record.state = "stopped")),
      delete: vi.fn(async () => void machines.delete(record.name)),
      exec: vi.fn(
        async (
          _command: string[],
          _options?: Parameters<SmolMachine["exec"]>[1],
        ): Promise<ExecResult> => OK,
      ),
      readFile: vi.fn(async (_path: string) => Buffer.from("contents")),
      writeFile: vi.fn(
        async (_path: string, _data: Uint8Array, _mode?: number) => {},
      ),
    } satisfies SmolMachine;
  }
  const track = (record: MachineRecord) => {
    const handle = handleFor(record);
    handles.set(record.name, handle);
    return handle;
  };
  const sdk = {
    create: vi.fn(async (config: MachineConfig, _conn: object) => {
      if (machines.has(config.name ?? "")) {
        throw smolError("CONFLICT", `machine ${config.name} exists`);
      }
      const record = {
        name: config.name ?? "",
        state: "running",
        labels: config.labels ?? {},
      };
      machines.set(record.name, record);
      return track(record);
    }),
    connect: vi.fn(async (name: string, _conn: object) => {
      const record = machines.get(name);
      if (!record) throw smolError("NOT_FOUND", `VM not found: ${name}`);
      record.state = "running";
      return track(record);
    }),
    list: vi.fn(
      async (
        _conn: object,
        options: { labels?: Record<string, string> },
      ): Promise<MachineSummary[]> =>
        [...machines.values()]
          .filter((m) =>
            Object.entries(options.labels ?? {}).every(
              ([key, value]) => m.labels[key] === value,
            ),
          )
          .map((m) => ({
            ...m,
            id: m.name,
            persistent: true,
            detached: false,
            branchable: false,
            createdAt: "2026-10-06T00:00:00Z",
          })),
    ),
    localAvailability: vi.fn(
      (): ReturnType<SmolMachines["localAvailability"]> => ({
        available: true,
      }),
    ),
  } satisfies SmolMachines;
  return { sdk, machines, handles };
}

/** A runtime over a fake SDK, with machines as an earlier daemon left them. */
function harness(initial: MachineRecord[] = []) {
  const fake = fakeSdk(initial);
  return { ...fake, runtime: providerRuntime(fake.sdk) };
}

/** A machine an earlier daemon created and left stopped, with no handle. */
function stopped(name = "demo", labels: Record<string, string> = {}) {
  return { name, state: "stopped", labels: { ...OWNED, ...labels } };
}

/** The status a runtime call fails with. */
async function statusOf(call: Promise<unknown>): Promise<number> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RuntimeError);
  return (error as RuntimeError).status;
}

const create = { name: "demo", image: "img", network: true };

describe("providerRuntime", () => {
  describe("create", () => {
    it("creates a persistent, owned machine with its image, env, sizes and services", async () => {
      const { runtime, sdk } = harness();
      const info = await runtime.create({
        name: "demo",
        image: "ubuntu:24.04",
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
        network: false,
        env: [{ name: "MODE", value: "test" }],
        services: [
          { name: "web", port: 3000 },
          { name: "web-alias", port: 3000 },
          { name: "amikad", port: 60999 },
        ],
      });
      expect(info).toEqual({
        name: "demo",
        state: "running",
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
      });
      expect(sdk.create).toHaveBeenCalledTimes(1);
      const [config, conn] = sdk.create.mock.calls[0];
      expect(conn).toEqual(LOCAL);
      expect(config).toMatchObject({
        name: "demo",
        image: "ubuntu:24.04",
        env: { MODE: "test" },
        persistent: true,
        resources: { cpus: 2, memoryMb: 1024, storageGb: 10, network: false },
        labels: OWNED,
      });
      // Each guest port is published once, on a host port the provider picks.
      expect(config.ports?.map((p) => p.guest)).toEqual([3000, 60999]);
      for (const port of config.ports ?? []) {
        expect(port.host).toBeGreaterThan(0);
      }
    });

    it("fills smolvm's defaults for the dimensions a create leaves out", async () => {
      const { runtime, sdk } = harness();
      const info = await runtime.create({ ...create, cpus: 2 });
      expect(info).toMatchObject({ cpus: 2, memoryMb: 8192, storageGb: 20 });
      expect(sdk.create.mock.calls[0][0].resources).toMatchObject({
        cpus: 2,
        memoryMb: 8192,
        storageGb: 20,
      });
    });

    it("reports smolvm's defaults for an unsized machine", async () => {
      const { runtime } = harness();
      expect(await runtime.create(create)).toEqual({
        name: "demo",
        state: "running",
        cpus: 4,
        memoryMb: 8192,
        storageGb: 20,
      });
    });

    it.each([true, false])("sets network=%s", async (network) => {
      const { runtime, sdk } = harness();
      await runtime.create({ ...create, network });
      expect(sdk.create.mock.calls[0][0].resources?.network).toBe(network);
    });

    it("answers 409 for a machine that already exists", async () => {
      const { runtime } = harness([stopped()]);
      expect(await statusOf(runtime.create(create))).toBe(409);
    });

    it("answers 503 with the reason on a host that cannot run machines", async () => {
      const { runtime, sdk } = harness();
      sdk.localAvailability.mockReturnValue({
        available: false,
        code: "KVM_UNAVAILABLE",
        reason: "/dev/kvm missing",
      });
      const error = await runtime.create(create).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503, message: "/dev/kvm missing" });
      expect(sdk.create).not.toHaveBeenCalled();
    });
  });

  describe("list and get", () => {
    it("lists only the provider's machines, sized from their labels", async () => {
      const { runtime } = harness([
        stopped("demo", {
          "amika-smolvm-sdk.cpus": "2",
          "amika-smolvm-sdk.memory-mb": "2048",
          "amika-smolvm-sdk.storage-gb": "30",
        }),
        // Another embedder's machine on the same engine.
        { name: "other", state: "running", labels: {} },
      ]);
      const demo = {
        name: "demo",
        state: "stopped",
        cpus: 2,
        memoryMb: 2048,
        storageGb: 30,
      };
      expect(await runtime.list()).toEqual([demo]);
      expect(await runtime.get("demo")).toEqual(demo);
    });

    it.each(["missing", "other"])(
      "answers 404 for %s, which the provider does not own",
      async (name) => {
        const { runtime } = harness([
          { name: "other", state: "running", labels: {} },
        ]);
        expect(await statusOf(runtime.get(name))).toBe(404);
      },
    );
  });

  describe("start and stop", () => {
    it("boots a machine an earlier daemon left stopped", async () => {
      const { runtime, sdk } = harness([stopped()]);
      expect((await runtime.start("demo")).state).toBe("running");
      expect(sdk.connect).toHaveBeenCalledWith("demo", LOCAL);
    });

    it("stops a running machine through its handle", async () => {
      const { runtime, handles } = harness();
      await runtime.create(create);
      expect((await runtime.stop("demo")).state).toBe("stopped");
      expect(handles.get("demo")?.stop).toHaveBeenCalledTimes(1);
    });

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness();
      expect(await statusOf(runtime.start("missing"))).toBe(404);
      expect(await statusOf(runtime.stop("missing"))).toBe(404);
    });
  });

  describe("remove", () => {
    it("deletes the machine", async () => {
      const { runtime, machines, handles } = harness();
      await runtime.create(create);
      await runtime.remove("demo");
      expect(handles.get("demo")?.delete).toHaveBeenCalledTimes(1);
      expect(machines.has("demo")).toBe(false);
    });

    it("answers 404 for a missing machine, which the provider ignores", async () => {
      const { runtime, sdk } = harness();
      expect(await statusOf(runtime.remove("missing"))).toBe(404);
      expect(sdk.connect).not.toHaveBeenCalled();
    });
  });

  describe("exec", () => {
    async function running() {
      const h = harness();
      await h.runtime.create(create);
      return { ...h, handle: h.handles.get("demo")! };
    }

    it("runs argv as one shell-quoted command as root, with cwd and env", async () => {
      const { runtime, handle } = await running();
      handle.exec.mockResolvedValueOnce({
        exitCode: 7,
        stdout: "out",
        stderr: "err",
      });
      const result = await runtime.exec("demo", {
        command: ["printf", "%s", "it's $HOME"],
        workdir: "/workspace",
        env: [{ name: "A", value: "a b" }],
      });
      expect(result).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
      expect(handle.exec).toHaveBeenCalledWith(
        ["/bin/sh", "-c", `'printf' '%s' 'it'\\''s $HOME'`],
        { env: { A: "a b" }, workdir: "/workspace", user: "0:0" },
      );
    });

    it("stages stdin in a guest file and redirects it in", async () => {
      const { runtime, handle } = await running();
      await runtime.exec("demo", { command: ["cat"], stdin: "input" });
      const [[file, data, mode]] = handle.writeFile.mock.calls;
      expect(file).toMatch(/^\/tmp\/\.amika-stdin-/);
      expect(Buffer.from(data).toString()).toBe("input");
      expect(mode).toBe(0o600);
      const [command] = handle.exec.mock.calls[0];
      expect(command).toEqual([
        "/bin/sh",
        "-c",
        'exec /bin/sh -c "$1" < "$0"',
        file,
        "'cat'",
      ]);
    });

    it.each(["root", "0", "0:0"])("accepts user %s", async (user) => {
      const { runtime, handle } = await running();
      await runtime.exec("demo", { command: ["id"], user });
      expect(handle.exec).toHaveBeenCalledTimes(1);
    });

    it.each(["ubuntu", "1000", "root:wheel"])(
      "refuses user %s with 400",
      async (user) => {
        const { runtime, handle } = await running();
        expect(
          await statusOf(runtime.exec("demo", { command: ["id"], user })),
        ).toBe(400);
        expect(handle.exec).not.toHaveBeenCalled();
      },
    );

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness();
      expect(await statusOf(runtime.exec("missing", { command: ["id"] }))).toBe(
        404,
      );
    });
  });

  describe("files", () => {
    async function running() {
      const h = harness();
      await h.runtime.create(create);
      return { ...h, handle: h.handles.get("demo")! };
    }

    it("reads a file as bytes", async () => {
      const { runtime, handle } = await running();
      handle.readFile.mockResolvedValueOnce(Buffer.from("hello"));
      expect(await runtime.readFile("demo", "/etc/motd")).toEqual(
        Buffer.from("hello"),
      );
      expect(handle.readFile).toHaveBeenCalledWith("/etc/motd");
    });

    it("answers 404 for a missing file", async () => {
      const { runtime, handle } = await running();
      handle.readFile.mockRejectedValueOnce(smolError("NOT_FOUND"));
      expect(await statusOf(runtime.readFile("demo", "/nope"))).toBe(404);
    });

    it("writes a file", async () => {
      const { runtime, handle } = await running();
      await runtime.writeFile("demo", "/a.bin", new Uint8Array([0, 255]));
      expect(handle.writeFile).toHaveBeenCalledWith(
        "/a.bin",
        Buffer.from([0, 255]),
      );
    });

    it("boots a stopped machine to reach its files", async () => {
      const { runtime, sdk } = harness([stopped()]);
      await runtime.readFile("demo", "/etc/motd");
      expect(sdk.connect).toHaveBeenCalledWith("demo", LOCAL);
    });
  });

  describe("services", () => {
    async function published() {
      const h = harness();
      await h.runtime.create({
        ...create,
        services: [{ name: "web", port: 3000 }],
      });
      const [{ host }] = h.sdk.create.mock.calls[0][0].ports ?? [];
      return { ...h, host };
    }

    it("accepts services on ports published at create", async () => {
      const { runtime } = await published();
      await expect(
        runtime.checkServices("demo", [
          { name: "site", port: 3000 },
          { name: "site-admin", port: 3000 },
        ]),
      ).resolves.toBeUndefined();
      await expect(runtime.checkServices("demo", [])).resolves.toBeUndefined();
    });

    it("lets names on a published port be dropped, as hostd routes by name", async () => {
      // The provider cannot unpublish a port and refuses to reconcile routes
      // that drop one; hostd only stops routing the dropped name.
      const { runtime } = harness();
      await runtime.create({
        ...create,
        services: [
          { name: "web", port: 3000 },
          { name: "amikad", port: 60999 },
        ],
      });
      await expect(
        runtime.checkServices("demo", [{ name: "amikad", port: 60999 }]),
      ).resolves.toBeUndefined();
    });

    it("refuses an unpublished port with 409, naming it", async () => {
      const { runtime } = await published();
      const error = await runtime
        .checkServices("demo", [
          { name: "web", port: 3000 },
          { name: "api", port: 4000 },
        ])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).status).toBe(409);
      expect((error as RuntimeError).message).toContain(
        "does not publish 4000",
      );
    });

    it("answers 404 when checking a missing machine's services", async () => {
      const { runtime } = harness();
      expect(
        await statusOf(
          runtime.checkServices("missing", [{ name: "web", port: 3000 }]),
        ),
      ).toBe(404);
    });

    it("reports the host port a running machine publishes", async () => {
      const { runtime, host } = await published();
      expect(await runtime.hostPort("demo", 3000)).toBe(host);
    });

    it("reports no host port for an unpublished guest port", async () => {
      const { runtime } = await published();
      expect(await runtime.hostPort("demo", 4000)).toBeNull();
    });

    it("reports no host port for a stopped machine", async () => {
      const { runtime } = await published();
      await runtime.stop("demo");
      expect(await runtime.hostPort("demo", 3000)).toBeNull();
    });

    it("reports no host port for a missing machine", async () => {
      const { runtime } = harness();
      expect(await runtime.hostPort("missing", 3000)).toBeNull();
    });

    it("reports no host port when the engine fails", async () => {
      const { runtime, sdk } = await published();
      sdk.list.mockRejectedValueOnce(new Error("engine down"));
      expect(await runtime.hostPort("demo", 3000)).toBeNull();
    });
  });

  describe("errors", () => {
    it.each([
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["INVALID_STATE", 409],
      ["INVALID_CONFIG", 400],
      ["KVM_UNAVAILABLE", 503],
      ["TIMEOUT", 504],
      ["SOMETHING_NEW", 500],
    ])("maps the SDK's %s to %i", async (code, status) => {
      const { runtime, sdk } = harness();
      sdk.list.mockRejectedValueOnce(smolError(code));
      expect(await statusOf(runtime.list())).toBe(status);
    });

    it("answers 500 for an error with no code", async () => {
      const { runtime, sdk } = harness();
      sdk.list.mockRejectedValueOnce(new Error("engine failed"));
      expect(await statusOf(runtime.list())).toBe(500);
    });

    it("answers 503 with the reason when the host cannot run machines", async () => {
      const { runtime, sdk } = harness();
      sdk.list.mockRejectedValueOnce(new Error("engine failed"));
      sdk.localAvailability.mockReturnValue({
        available: false,
        code: "KVM_UNAVAILABLE",
        reason: "/dev/kvm missing",
      });
      const error = await runtime.list().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({ status: 503, message: "/dev/kvm missing" });
    });

    it("checks the host only for an unmapped failure", async () => {
      const { runtime, sdk } = harness();
      sdk.list.mockRejectedValueOnce(smolError("CONFLICT"));
      sdk.localAvailability.mockReturnValue({
        available: false,
        code: "KVM_UNAVAILABLE",
        reason: "/dev/kvm missing",
      });
      expect(await statusOf(runtime.list())).toBe(409);
    });
  });

  describe("stopAll", () => {
    it("stops every machine this process holds, keeping them", async () => {
      const { runtime, handles, machines } = harness();
      await runtime.create(create);
      await runtime.create({ ...create, name: "second" });
      await runtime.stopAll();
      expect(handles.get("demo")?.stop).toHaveBeenCalledTimes(1);
      expect(handles.get("second")?.stop).toHaveBeenCalledTimes(1);
      expect([...machines.keys()]).toEqual(["demo", "second"]);
    });

    it("leaves alone machines it holds no handle on", async () => {
      const { runtime, sdk } = harness([stopped()]);
      await runtime.stopAll();
      expect(sdk.connect).not.toHaveBeenCalled();
    });
  });
});
