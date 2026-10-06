import { describe, expect, it, vi } from "vitest";
import type { MachineConfig, MachineSummary } from "smolmachines";
import { SandboxProviderUnsupportedError } from "../../provider";
import type { SandboxService } from "../../../types";
import type { SmolMachine, SmolMachines } from "./client";
import {
  SmolvmSdkNotFoundError,
  SmolvmSdkUnavailableError,
  SmolvmSdkUnpublishedPortError,
  SmolvmSdkUnrevocablePortError,
  mapSmolvmSdkState,
  smolvmSdkOperations,
} from "./operations";

const OWNED = { "amika-smolvm-sdk": "1" };
const OK = { exitCode: 0, stdout: "", stderr: "" };
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

type Handle = {
  [K in keyof SmolMachine]: SmolMachine[K] &
    ReturnType<typeof vi.fn<SmolMachine[K]>>;
} & { state: ReturnType<typeof vi.fn<() => never>> };

/**
 * An SDK over an in-memory machine table. As the real one does, `create`
 * and `connect` boot the machine, and `list` filters by label.
 */
function fakeSdk(initial: MachineRecord[] = []) {
  const machines = new Map(initial.map((m) => [m.name, { ...m }]));
  const handles: Handle[] = [];
  const handleFor = (record: MachineRecord): Handle => {
    const handle: Handle = {
      start: vi.fn(async () => {
        // As the engine does: a paused machine refuses a fresh boot.
        if (record.state === "paused") throw smolError("CONFLICT");
        record.state = "running";
      }),
      resume: vi.fn(async () => void (record.state = "running")),
      stop: vi.fn(async () => void (record.state = "stopped")),
      delete: vi.fn(async () => void machines.delete(record.name)),
      exec: vi.fn(
        async (_command: string[], _options?: object) => OK,
      ) as Handle["exec"],
      readFile: vi.fn(async (_path: string) => Buffer.from("contents")),
      writeFile: vi.fn(
        async (_path: string, _data: Uint8Array, _mode?: number) => {},
      ),
      // The real `Machine.state()` blocks the event loop during a file
      // transfer; the provider must never call it.
      state: vi.fn(() => {
        throw new Error("state() called");
      }),
    };
    handles.push(handle);
    return handle;
  };
  const sdk = {
    create: vi.fn(async (config: MachineConfig, _conn: object) => {
      const name = config.name ?? "";
      if (machines.has(name)) throw smolError("CONFLICT");
      const record = { name, state: "running", labels: config.labels ?? {} };
      machines.set(name, record);
      return handleFor(record);
    }),
    connect: vi.fn(async (name: string, _conn: object) => {
      const record = machines.get(name);
      if (!record) throw smolError("NOT_FOUND");
      record.state = "running";
      return handleFor(record);
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

/**
 * Operations over a fresh fake SDK. Each fake is its own SDK object, so the
 * provider's per-SDK handle cache starts empty in every test.
 */
function harness(initial: MachineRecord[] = [], network?: boolean) {
  const fake = fakeSdk(initial);
  return { ...fake, ops: smolvmSdkOperations({ network }, fake.sdk) };
}

const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
  fn.mock.invocationCallOrder[0];

function service(name: string, containerPort: number): SandboxService {
  return { name, url: "", hostPort: 0, containerPort, protocol: "tcp" };
}

const INPUT = { name: "demo", snapshot: "ubuntu:24.04", services: [] };

describe("smolvmSdkOperations", () => {
  describe("create", () => {
    it("creates a persistent, labeled machine and publishes each port once", async () => {
      const { ops, sdk } = harness([], true);
      const created = await ops.create({
        ...INPUT,
        resources: { vcpus: 2, memoryGib: 1.5, diskGib: 10 },
        envVars: { MODE: "test" },
        labels: { "amika-org-id": "org_1" },
        services: [
          service("web", 3000),
          service("web-alias", 3000),
          { ...service("amikad", 60999), urlScheme: "https" },
        ],
      });
      const [config, conn] = sdk.create.mock.calls[0];
      expect(conn).toEqual(LOCAL);
      expect(config).toMatchObject({
        name: "demo",
        image: "ubuntu:24.04",
        env: { MODE: "test" },
        resources: { cpus: 2, memoryMb: 1536, storageGb: 10, network: true },
        persistent: true,
      });
      const ports = config.ports ?? [];
      expect(ports.map((p) => p.guest)).toEqual([3000, 60999]);
      expect(new Set(ports.map((p) => p.host)).size).toBe(2);
      expect(config.labels).toEqual({
        "amika-org-id": "org_1",
        "amika-smolvm-sdk": "1",
        "amika-smolvm-sdk.cpus": "2",
        "amika-smolvm-sdk.memory-mb": "1536",
        "amika-smolvm-sdk.storage-gb": "10",
        "amika-smolvm-sdk.ports": ports
          .map((p) => `${p.host}:${p.guest}`)
          .join(","),
      });
      const [web, alias, amikad] = created.services;
      expect(web.hostPort).toBe(ports[0].host);
      expect(alias.hostPort).toBe(ports[0].host);
      expect(web.url).toBe(`http://127.0.0.1:${ports[0].host}`);
      expect(amikad.url).toBe(`https://127.0.0.1:${ports[1].host}`);
      expect(created).toMatchObject({
        provider: "smolvm-sdk",
        providerSandboxId: "demo",
        envVars: { MODE: "test" },
      });
    });

    it("uses smolvm's default sizes and keeps networking off by default", async () => {
      const { ops, sdk } = harness();
      await ops.create(INPUT);
      expect(sdk.create.mock.calls[0][0]).toMatchObject({
        ports: [],
        resources: {
          cpus: 4,
          memoryMb: 8192,
          storageGb: 20,
          network: false,
        },
      });
    });

    it("refuses on a host that cannot run machines, creating nothing", async () => {
      const { ops, sdk } = harness();
      sdk.localAvailability.mockReturnValue({
        available: false,
        code: "KVM_UNAVAILABLE",
        reason: "KVM unavailable",
      });
      const failure = await ops.create(INPUT).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(SmolvmSdkUnavailableError);
      expect(failure).toMatchObject({
        code: "KVM_UNAVAILABLE",
        message: "KVM unavailable",
      });
      expect(sdk.create).not.toHaveBeenCalled();
    });

    it.each([
      [{ snapshot: " " }],
      [{ services: [{ ...service("dns", 53), protocol: "udp" as const }] }],
      [{ autoStopInterval: 5 }],
      [{ autoDeleteInterval: 5 }],
      [{ resources: { vcpus: 17, memoryGib: 1, diskGib: 1 } }],
      [{ resources: { vcpus: 1, memoryGib: 0.01, diskGib: 1 } }],
    ])("rejects %j before creating anything", async (overrides) => {
      const { ops, sdk } = harness();
      await expect(ops.create({ ...INPUT, ...overrides })).rejects.toThrow();
      expect(sdk.create).not.toHaveBeenCalled();
    });

    it("passes on the SDK's error, code included", async () => {
      const { ops, sdk } = harness();
      sdk.create.mockRejectedValueOnce(smolError("TIMEOUT"));
      await expect(ops.create(INPUT)).rejects.toMatchObject({
        code: "TIMEOUT",
      });
    });
  });

  describe("state and listing", () => {
    it("reports an owned machine's state, and unknown otherwise", async () => {
      const { ops } = harness([
        { name: "ours", state: "stopped", labels: OWNED },
        { name: "theirs", state: "running", labels: {} },
      ]);
      expect(await ops.getState("ours")).toBe("stopped");
      expect(await ops.getState("theirs")).toBe("unknown");
      expect(await ops.getState("missing")).toBe("unknown");
    });

    it("lists only owned machines, with sizing and org from labels", async () => {
      const { ops, sdk } = harness([
        {
          name: "ours",
          state: "running",
          labels: {
            ...OWNED,
            "amika-org-id": "org_1",
            "amika-smolvm-sdk.cpus": "2",
            "amika-smolvm-sdk.memory-mb": "1536",
            "amika-smolvm-sdk.storage-gb": "10",
          },
        },
        { name: "theirs", state: "running", labels: {} },
      ]);
      expect(await ops.list()).toEqual([
        {
          providerSandboxId: "ours",
          orgId: "org_1",
          state: "running",
          sizing: { vcpus: 2, memoryGib: 1.5, diskGib: 10 },
        },
      ]);
      expect(sdk.list).toHaveBeenCalledWith(LOCAL, { labels: OWNED });
    });

    it.each(["0x10", "1e3", "0", "-2", " 2", "2.5", ""])(
      "falls back to the default for a size label of %j",
      async (cpus) => {
        const { ops } = harness([
          {
            name: "demo",
            state: "running",
            labels: {
              ...OWNED,
              "amika-smolvm-sdk.cpus": cpus,
              "amika-smolvm-sdk.memory-mb": "1024",
            },
          },
        ]);
        expect((await ops.list())[0].sizing).toEqual({
          vcpus: 4,
          memoryGib: 1,
          diskGib: 20,
        });
      },
    );

    it("falls back to defaults for unreadable labels", async () => {
      const { ops } = harness([
        {
          name: "demo",
          state: "stopped",
          labels: { ...OWNED, "amika-smolvm-sdk.cpus": "lots" },
        },
      ]);
      expect((await ops.list())[0]).toMatchObject({
        orgId: null,
        sizing: { vcpus: 4, memoryGib: 8, diskGib: 20 },
      });
      expect(await ops.ports("demo")).toEqual([]);
    });

    it.each([
      ["running", "running"],
      ["starting", "starting"],
      ["stopping", "stopping"],
      ["stopped", "stopped"],
      ["created", "creating"],
      ["failed", "failed"],
      ["pausing", "suspending"],
      ["paused", "suspended"],
      ["frozen", "unknown"],
    ])("maps %s to %s", (raw, status) => {
      expect(mapSmolvmSdkState(raw)).toBe(status);
    });
  });

  describe("start and stop", () => {
    it("starts a held, stopped machine and leaves a running one alone", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      await ops.start("demo");
      expect(handles[0].start).not.toHaveBeenCalled();
      await ops.stop("demo");
      await ops.start("demo");
      expect(handles[0].start).toHaveBeenCalledTimes(1);
    });

    it.each(["start", "exec", "read"] as const)(
      "resumes a held, paused machine on %s instead of booting it",
      async (operation) => {
        const { ops, machines, handles } = harness();
        await ops.create(INPUT);
        // Paused through the smol CLI, say.
        machines.get("demo")!.state = "paused";
        if (operation === "start") await ops.start("demo");
        if (operation === "exec") await ops.run("demo", "true");
        if (operation === "read") await ops.read("demo", "/a");
        expect(handles[0].resume).toHaveBeenCalledTimes(1);
        expect(handles[0].start).not.toHaveBeenCalled();
      },
    );

    it("leaves a paused machine alone on stop", async () => {
      const { ops, machines, handles } = harness();
      await ops.create(INPUT);
      machines.get("demo")!.state = "paused";
      await ops.stop("demo");
      expect(handles[0].stop).not.toHaveBeenCalled();
    });

    it("connects to a machine an earlier process left, which boots it", async () => {
      const { ops, sdk } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await ops.start("demo");
      expect(sdk.connect).toHaveBeenCalledWith("demo", LOCAL);
      await ops.start("demo");
      expect(sdk.connect).toHaveBeenCalledTimes(1);
    });

    it("never connects to a machine it does not own", async () => {
      const { ops, sdk } = harness([
        { name: "demo", state: "stopped", labels: {} },
      ]);
      await expect(ops.start("demo")).rejects.toBeInstanceOf(
        SmolvmSdkNotFoundError,
      );
      expect(sdk.connect).not.toHaveBeenCalled();
    });

    it("re-checks ownership even with a handle held", async () => {
      const { ops, machines, handles } = harness();
      await ops.create(INPUT);
      await ops.stop("demo");
      machines.set("demo", { name: "demo", state: "stopped", labels: {} });
      await expect(ops.start("demo")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(handles[0].start).not.toHaveBeenCalled();
    });

    it("rejects an auto-stop timer", async () => {
      const { ops } = harness();
      await expect(ops.start("demo", 5)).rejects.toBeInstanceOf(
        SandboxProviderUnsupportedError,
      );
    });

    it("leaves a stopped machine from an earlier run alone on stop", async () => {
      const { ops, sdk } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await ops.stop("demo");
      expect(sdk.connect).not.toHaveBeenCalled();
    });

    it("connects to stop a running machine it holds no handle for", async () => {
      const { ops, handles } = harness([
        { name: "demo", state: "running", labels: OWNED },
      ]);
      await ops.stop("demo");
      expect(handles[0].stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete", () => {
    it("deletes a held machine and forgets its handle", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      await ops.remove("demo");
      expect(handles[0].delete).toHaveBeenCalledTimes(1);
      await ops.create(INPUT);
      await ops.stop("demo");
      expect(handles[1].stop).toHaveBeenCalled();
      expect(handles[0].stop).not.toHaveBeenCalled();
    });

    it("connects, booting it, to delete a machine from an earlier run", async () => {
      const { ops, sdk, handles } = harness([
        { name: "demo", state: "stopped", labels: OWNED },
      ]);
      await ops.remove("demo");
      expect(order(sdk.connect)).toBeLessThan(order(handles[0].delete));
    });

    it("treats a missing or foreign machine as already deleted", async () => {
      const { ops, sdk } = harness([
        { name: "theirs", state: "running", labels: {} },
      ]);
      await ops.remove("missing");
      await ops.remove("theirs");
      expect(sdk.connect).not.toHaveBeenCalled();
    });
  });

  describe("exec", () => {
    it("runs the command under /bin/sh as root, starting the machine", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      await ops.stop("demo");
      const [handle] = handles;
      handle.exec.mockResolvedValueOnce({
        exitCode: 3,
        stdout: "out",
        stderr: "err",
      });
      expect(
        await ops.run("demo", "ls -la", {
          cwd: "/workspace",
          env: { A: "a b" },
        }),
      ).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
      expect(handle.exec).toHaveBeenCalledWith(["/bin/sh", "-c", "ls -la"], {
        env: { A: "a b" },
        workdir: "/workspace",
        user: "0:0",
      });
      expect(order(handle.start)).toBeLessThan(order(handle.exec));
    });

    it.each([
      ["without stdin", undefined],
      ["with stdin", "input"],
    ])("returns only the contract's fields %s", async (_label, input) => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      // The SDK's result carries byte copies, flags and helpers besides.
      handles[0].exec.mockResolvedValue({
        exitCode: 0,
        stdout: "out",
        stderr: "",
        stdoutBytes: new Uint8Array([111, 117, 116]),
        stdoutTruncated: false,
        output: "out",
      } as never);
      expect(await ops.run("demo", "echo out", { input })).toStrictEqual({
        exitCode: 0,
        stdout: "out",
        stderr: "",
      });
    });

    it("stages stdin in a root-only guest file and removes it", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      const [handle] = handles;
      await ops.run("demo", "cat", { input: "secret" });
      const [[file, data, mode]] = handle.writeFile.mock.calls;
      expect(file).toMatch(/^\/tmp\/\.amika-stdin-[0-9a-f-]{36}$/);
      expect(data).toEqual(Buffer.from("secret"));
      expect(mode).toBe(0o600);
      expect(handle.exec.mock.calls.map(([command]) => command)).toEqual([
        ["/bin/sh", "-c", 'exec /bin/sh -c "$1" < "$0"', file, "cat"],
        ["rm", "-f", file],
      ]);
    });

    it("removes the stdin file even when staging it fails", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      const [handle] = handles;
      handle.writeFile.mockRejectedValueOnce(new Error("disk full"));
      await expect(ops.run("demo", "cat", { input: "x" })).rejects.toThrow(
        "disk full",
      );
      const file = handle.writeFile.mock.calls[0][0];
      expect(handle.exec.mock.calls.map(([command]) => command)).toEqual([
        ["rm", "-f", file],
      ]);
    });
  });

  describe("files", () => {
    it("reads text and writes bytes through a running machine", async () => {
      const { ops, handles } = harness();
      await ops.create(INPUT);
      const [handle] = handles;
      expect(await ops.read("demo", "/etc/hostname")).toBe("contents");
      await ops.write("demo", "/a.txt", "hi");
      expect(handle.writeFile).toHaveBeenCalledWith(
        "/a.txt",
        Buffer.from("hi"),
      );
    });

    it.each([
      ["a missing file", "file"],
      ["a missing machine", "machine"],
    ])("reads null for %s", async (_label, missing) => {
      const { ops, handles } = harness();
      if (missing === "file") {
        await ops.create(INPUT);
        handles[0].readFile.mockRejectedValueOnce(smolError("NOT_FOUND"));
      }
      expect(await ops.read("demo", "/nope")).toBeNull();
    });
  });

  describe("services", () => {
    const published = [
      {
        name: "demo",
        state: "running",
        labels: { ...OWNED, "amika-smolvm-sdk.ports": "41001:3000" },
      },
    ];

    it("refreshes local URLs for published ports", async () => {
      const { ops } = harness(published);
      const { services } = await ops.refreshUrls("demo", [
        service("web", 3000),
        service("other", 4000),
      ]);
      expect(services[0]).toMatchObject({
        hostPort: 41001,
        url: "http://127.0.0.1:41001",
      });
      expect(services[1]).toEqual(service("other", 4000));
    });

    it("accepts routes on exactly the published ports", async () => {
      const { ops } = harness(published);
      await ops.syncRoutes("demo", [service("site", 3000)]);
      // Revoking one of two services on a port leaves the port routed.
      await ops.syncRoutes("demo", [
        service("site", 3000),
        service("site-admin", 3000),
      ]);
    });

    it("refuses a service switched to UDP on a published port", async () => {
      // The port set is unchanged, but the published forward is TCP.
      const { ops, sdk } = harness(published);
      await expect(
        ops.syncRoutes("demo", [{ ...service("site", 3000), protocol: "udp" }]),
      ).rejects.toBeInstanceOf(SandboxProviderUnsupportedError);
      expect(sdk.list).not.toHaveBeenCalled();
    });

    it("refuses a port the machine did not publish", async () => {
      const { ops } = harness(published);
      await expect(
        ops.syncRoutes("demo", [service("site", 3000), service("api", 4000)]),
      ).rejects.toBeInstanceOf(SmolvmSdkUnpublishedPortError);
    });

    it("refuses to drop a published port, which would stay open", async () => {
      const { ops } = harness(published);
      const failure = await ops
        .syncRoutes("demo", [])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SmolvmSdkUnrevocablePortError);
      expect(failure).toMatchObject({
        code: "CONFLICT",
        message:
          "smolvm machines cannot unpublish ports; machine demo still publishes 3000",
      });
    });
  });

  it("shares handles across operations built over one SDK", async () => {
    const fake = fakeSdk([{ name: "demo", state: "stopped", labels: OWNED }]);
    await smolvmSdkOperations({}, fake.sdk).start("demo");
    await smolvmSdkOperations({}, fake.sdk).start("demo");
    expect(fake.sdk.connect).toHaveBeenCalledTimes(1);
  });

  it("never calls a machine's state(), which blocks during a transfer", async () => {
    const { ops, handles } = harness();
    await ops.create(INPUT);
    await ops.getState("demo");
    await ops.list();
    await ops.run("demo", "true", { input: "x" });
    await ops.read("demo", "/a");
    await ops.write("demo", "/a", "b");
    await ops.stop("demo");
    await ops.start("demo");
    await ops.stopAll();
    await ops.remove("demo");
    expect(handles[0].state).not.toHaveBeenCalled();
  });

  it("stops every held machine on stopAll, past a failure", async () => {
    const { ops, handles } = harness();
    await ops.create(INPUT);
    await ops.create({ ...INPUT, name: "other" });
    handles[0].stop.mockRejectedValueOnce(new Error("stuck"));
    await expect(ops.stopAll()).resolves.toBeUndefined();
    expect(handles[1].stop).toHaveBeenCalled();
  });
});
