/**
 * The local machine runtime: smolvm's engine, embedded in the daemon through
 * the `smolmachines` SDK, so no `smolvm` binary or `smolvm serve` process
 * runs alongside hostd.
 *
 * The daemon drives the SDK's native machine handle rather than its
 * `Machine` class. `Machine.create` and `Machine.connect` wait until every
 * published guest port accepts connections, and delete a new machine whose
 * ports do not within two minutes; a rig's services (amikad, or a dev server
 * nobody has started yet) need not be listening for the rig to exist. The
 * native handle creates, starts, stops and execs exactly as `smolvm serve`
 * did, with no such wait.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";

/** A published guest port and the host loopback port it is reached on. */
export interface PortMapping {
  host: number;
  guest: number;
}

/** A machine as the machine API reports it, in `smolvm serve`'s shape. */
export interface MachineInfo {
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  storageGb: number;
  ports: PortMapping[];
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface CreateMachine {
  name: string;
  image: string;
  cpus?: number;
  memoryMb?: number;
  storageGb?: number;
  network: boolean;
  env?: EnvVar[];
  ports?: PortMapping[];
}

export interface ExecRequest {
  command: string[];
  user?: string;
  workdir?: string;
  env?: EnvVar[];
  stdin?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Everything the machine API asks of the runtime. */
export interface MachineRuntime {
  list(): Promise<MachineInfo[]>;
  get(name: string): Promise<MachineInfo>;
  /** Record a machine without booting it. */
  create(machine: CreateMachine): Promise<MachineInfo>;
  start(name: string): Promise<MachineInfo>;
  stop(name: string): Promise<MachineInfo>;
  remove(name: string): Promise<void>;
  /** Exec and file access boot a stopped machine first, as smolvm's did. */
  exec(name: string, request: ExecRequest): Promise<ExecResult>;
  readFile(name: string, path: string): Promise<Buffer>;
  writeFile(name: string, path: string, data: Uint8Array): Promise<void>;
  /** Stop every machine this process runs, keeping their disks. */
  stopAll(): Promise<void>;
}

/** Whether this host can run machines, without booting one. */
export type HostAvailability =
  | { available: true }
  | { available: false; code?: string; reason?: string };

/** A failed runtime call, with the HTTP status the machine API answers. */
export class RuntimeError extends Error {
  override name = "RuntimeError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- The native engine ------------------------------------------------------

/** The subset of the SDK's native machine handle the daemon uses. */
export interface NativeMachine {
  readonly name: string;
  state(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
  delete(): Promise<void>;
  exec(
    command: string[],
    options?: {
      env?: { key: string; value: string }[];
      workdir?: string;
      user?: string;
    },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    data: Buffer,
    options?: { mode?: number },
  ): Promise<void>;
}

export interface NativeMachineConfig {
  name: string;
  image: string;
  env?: { key: string; value: string }[];
  ports?: PortMapping[];
  resources: {
    cpus: number;
    memoryMib: number;
    storageGib: number;
    network: boolean;
  };
  persistent: boolean;
  labels: Record<string, string>;
}

export interface NativeMachineSummary {
  name: string;
  state: string;
  labels: Record<string, string>;
}

/** The native engine's machine operations, injectable for tests. */
export interface NativeEngine {
  /** Record a machine in the engine's database; does not boot it. */
  create(config: NativeMachineConfig): NativeMachine;
  /**
   * A handle on an existing machine. The engine boots a stopped one first,
   * synchronously, so call this only for a running machine.
   */
  connect(name: string): NativeMachine;
  list(): Promise<NativeMachineSummary[]>;
  checkHost(): HostAvailability;
  /** Boot a stopped machine on a worker thread, leaving the event loop free. */
  boot(name: string): Promise<void>;
}

/**
 * Load the SDK's native engine from the `smolmachines` package installed
 * beside the daemon. The SDK finds its addon, boot helper and guest rootfs
 * on disk relative to its own files, so it is never bundled
 * (`scripts/bundle.mjs`), and its native handle is not part of the package's
 * exports, so it is loaded by path.
 */
export function loadNativeEngine(): NativeEngine {
  const require = createRequire(import.meta.url);
  const nativeModule = path.join(
    path.dirname(require.resolve("smolmachines")),
    "native.js",
  );
  const { getNapiMachine } = require(nativeModule) as {
    getNapiMachine(): {
      new (config: NativeMachineConfig): NativeMachine;
      connect(name: string): NativeMachine;
      list(): Promise<NativeMachineSummary[]>;
      checkHost(): HostAvailability;
    };
  };
  const Machine = getNapiMachine();
  return {
    create: (config) => new Machine(config),
    connect: (name) => Machine.connect(name),
    list: () => Machine.list(),
    checkHost: () => Machine.checkHost(),
    boot: (name) => bootOnWorker(nativeModule, name),
  };
}

// The engine's `connect` boots a stopped machine synchronously. The engine's
// state is per process, not per thread, so a worker can boot the machine and
// the main thread then reattaches to it, which is immediate.
const BOOT_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  require(workerData.nativeModule).getNapiMachine().connect(workerData.name);
  parentPort.postMessage({});
} catch (error) {
  parentPort.postMessage({ error: String((error && error.message) || error) });
}
`;

function bootOnWorker(nativeModule: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BOOT_WORKER, {
      eval: true,
      workerData: { nativeModule, name },
    });
    worker.once("message", (message: { error?: string }) => {
      if (message.error === undefined) resolve();
      else reject(new Error(message.error));
    });
    worker.once("error", reject);
    // A no-op once the worker has answered.
    worker.once("exit", (code) =>
      reject(new Error(`boot worker exited with code ${code}`)),
    );
  });
}

// --- The runtime ------------------------------------------------------------

/**
 * Labels hostd stores with each machine. The engine's database is shared
 * with the `smol` CLI and every other embedder on the host, so the owner
 * label keeps hostd to its own machines; the rest let hostd describe a
 * machine it is not running without booting it.
 */
const LABELS = {
  owner: "amika-hostd",
  cpus: "amika-hostd.cpus",
  memoryMb: "amika-hostd.memory-mb",
  storageGb: "amika-hostd.storage-gb",
  ports: "amika-hostd.ports",
} as const;

/** smolvm's defaults (`VmResources`, `DEFAULT_STORAGE_SIZE_GIB`). */
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY_MB = 8192;
const DEFAULT_STORAGE_GB = 20;

const portsLabelSchema = z
  .string()
  .transform((value) => (value === "" ? [] : value.split(",")))
  .pipe(
    z.array(
      z
        .string()
        .regex(/^\d+:\d+$/)
        .transform((pair) => {
          const [host, guest] = pair.split(":").map(Number);
          return { host, guest };
        }),
    ),
  );

/**
 * The machine runtime over the native engine. Machines are persistent (their
 * disks outlive stop and daemon restarts) but not detached: the engine reaps
 * them if the daemon dies, and `stopAll` stops them cleanly on shutdown.
 */
export function embeddedRuntime(
  loadEngine: () => NativeEngine = loadNativeEngine,
  { leaseGraceMs = LEASE_GRACE_MS }: { leaseGraceMs?: number } = {},
): MachineRuntime {
  // Loaded on first use, so a host that cannot run machines still serves
  // the rest of the API, answering machine requests with 503.
  let loaded: NativeEngine | undefined;
  const engine = (): NativeEngine => {
    try {
      loaded ??= loadEngine();
    } catch (error) {
      throw new RuntimeError(503, (error as Error).message);
    }
    return loaded;
  };
  // Handles on machines this process created or attached to. A machine left
  // stopped by an earlier daemon has none until it is next booted.
  const handles = new Map<string, NativeMachine>();
  // The tail of each machine's queue of lifecycle steps (attach, boot, stop,
  // delete), so concurrent requests for one machine never boot it twice or
  // interleave a start with a delete. Execs and file transfers queue only to
  // boot their machine, then run concurrently under a lease.
  const queues = new Map<string, Promise<unknown>>();
  const serially = <T>(name: string, step: () => Promise<T>): Promise<T> => {
    const result = (queues.get(name) ?? Promise.resolve()).then(step, step);
    const tail = result.catch(() => {});
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return result;
  };
  // The execs and file transfers each machine is running. They run
  // concurrently with each other; a stop or delete waits for them (see
  // `settled`) rather than cut a command or transfer off.
  const leases = new Map<string, Set<Promise<void>>>();
  /**
   * Run `operation` on a running machine under a lease taken inside the
   * queued step that boots it, so no stop or delete queued behind that step
   * can slip in before the lease is held.
   */
  const leased = async <T>(
    name: string,
    operation: (handle: NativeMachine) => Promise<T>,
  ): Promise<T> => {
    let release = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    const handle = await explained(() =>
      serially(name, async () => {
        const booted = await boot(name);
        const active = leases.get(name) ?? new Set();
        active.add(done);
        leases.set(name, active);
        return booted;
      }),
    );
    try {
      return await operation(handle);
    } finally {
      release();
      const active = leases.get(name);
      active?.delete(done);
      if (active?.size === 0) leases.delete(name);
    }
  };
  /**
   * Wait, from a queued stop or delete, for the machine's leased operations,
   * but no longer than `leaseGraceMs`: an exec has no time limit in the
   * guest, and one that never ends must not block deleting its machine.
   */
  const settled = async (name: string): Promise<void> => {
    const active = leases.get(name);
    if (!active?.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(active),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, leaseGraceMs);
      }),
    ]);
    clearTimeout(timer);
  };
  /**
   * A failed boot reports a generic engine error; when this host cannot run
   * machines at all, say so with 503, as for a failed engine load.
   */
  const explained = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RuntimeError && error.status === 500 && loaded) {
        const host = loaded.checkHost();
        if (!host.available) {
          throw new RuntimeError(503, host.reason ?? error.message);
        }
      }
      throw error;
    }
  };

  const summary = async (name: string): Promise<NativeMachineSummary> => {
    const found = (await native(() => engine().list())).find(
      (machine) => machine.name === name && isOwned(machine),
    );
    if (!found) throw new RuntimeError(404, `machine ${name} not found`);
    return found;
  };
  const describe = async (name: string): Promise<MachineInfo> => {
    const machine = await summary(name);
    return info(machine, handles.get(name)?.state() ?? machine.state);
  };
  /**
   * A handle, booting the machine if none is held. The engine's `connect`
   * boots a stopped machine on the calling thread, so it is only ever called
   * once the worker has booted the machine (immediate if it already runs).
   */
  const attach = async (name: string): Promise<NativeMachine> => {
    const held = handles.get(name);
    if (held) return held;
    await summary(name);
    await native(() => engine().boot(name));
    const handle = await native(async () => engine().connect(name));
    handles.set(name, handle);
    return handle;
  };
  /**
   * A running machine's handle. Call it only from a queued step.
   *
   * It always awaits `start`, which the engine answers at once for a running
   * machine, rather than checking `state()` first: `state()` is synchronous
   * and waits on the machine's lock, which a file transfer holds throughout,
   * so it would block the event loop, and every request, until the transfer
   * ends. `start` waits for that lock off the event loop.
   */
  const boot = async (name: string): Promise<NativeMachine> => {
    const handle = await attach(name);
    await native(() => handle.start());
    return handle;
  };
  const stop = async (name: string, state?: string) => {
    const handle = handles.get(name);
    if (handle) {
      if (handle.state() !== "stopped") await native(() => handle.stop());
    } else if (ACTIVE_STATES.has(state ?? (await summary(name)).state)) {
      // Running without a handle: started by an earlier daemon that is
      // still shutting down, say. Attaching boots nothing.
      await native(async () => (await attach(name)).stop());
    }
  };
  const exec = async (
    handle: NativeMachine,
    command: string[],
    options: { env?: EnvVar[]; workdir?: string; user?: string } = {},
  ) =>
    native(() =>
      handle.exec(command, {
        env: options.env?.map(({ name, value }) => ({ key: name, value })),
        workdir: options.workdir,
        user: options.user,
      }),
    );

  return {
    list: async () =>
      (await native(() => engine().list()))
        .filter(isOwned)
        .map((machine) =>
          info(machine, handles.get(machine.name)?.state() ?? machine.state),
        ),
    get: describe,
    create: (machine) =>
      serially(machine.name, async () => {
        // A machine recorded on a host that cannot boot it could only be
        // deleted by booting it (see `remove`).
        const host = engine().checkHost();
        if (!host.available) {
          throw new RuntimeError(
            503,
            host.reason ?? "this host cannot run machines",
          );
        }
        const resources = {
          cpus: machine.cpus ?? DEFAULT_CPUS,
          memoryMib: machine.memoryMb ?? DEFAULT_MEMORY_MB,
          storageGib: machine.storageGb ?? DEFAULT_STORAGE_GB,
          network: machine.network,
        };
        const ports = machine.ports ?? [];
        const handle = await native(async () =>
          engine().create({
            name: machine.name,
            image: machine.image,
            env: machine.env?.map(({ name, value }) => ({ key: name, value })),
            ports,
            resources,
            persistent: true,
            labels: {
              [LABELS.owner]: "1",
              [LABELS.cpus]: String(resources.cpus),
              [LABELS.memoryMb]: String(resources.memoryMib),
              [LABELS.storageGb]: String(resources.storageGib),
              [LABELS.ports]: ports
                .map((p) => `${p.host}:${p.guest}`)
                .join(","),
            },
          }),
        );
        handles.set(machine.name, handle);
        return describe(machine.name);
      }),
    // Each answers from inside its queued step, so a delete queued behind
    // it cannot remove the machine before the answer is read.
    start: (name) =>
      explained(() =>
        serially(name, async () => {
          await boot(name);
          return describe(name);
        }),
      ),
    stop: (name) =>
      explained(() =>
        serially(name, async () => {
          await settled(name);
          await stop(name);
          return describe(name);
        }),
      ),
    remove: (name) =>
      explained(() =>
        serially(name, async () => {
          // The engine deletes only through a handle, and the only handle on
          // a stopped machine from an earlier run comes from booting it.
          await settled(name);
          const handle = await attach(name);
          await native(() => handle.delete());
          handles.delete(name);
        }),
      ),
    exec: (name, request) =>
      leased(name, (handle) =>
        request.stdin === undefined
          ? exec(handle, request.command, request)
          : execWithStdin(handle, request, exec),
      ),
    readFile: (name, filePath) =>
      leased(name, (handle) => native(() => handle.readFile(filePath))),
    writeFile: (name, filePath, data) =>
      leased(name, async (handle) => {
        await native(() => handle.writeFile(filePath, Buffer.from(data)));
      }),
    stopAll: async () => {
      // An engine never loaded never booted anything.
      if (!loaded) return;
      const listed = await native(() => engine().list()).catch(() => []);
      const states = new Map<string, string | undefined>(
        listed.filter(isOwned).map((machine) => [machine.name, machine.state]),
      );
      for (const name of handles.keys()) states.set(name, undefined);
      // Each waits behind any boot still in flight for its machine, but not
      // for execs or transfers: the daemon is going away, and the caller
      // bounds how long stopping may take.
      await Promise.allSettled(
        [...states].map(([name, state]) =>
          serially(name, () => stop(name, state)),
        ),
      );
    },
  };
}

/**
 * How long a stop or delete waits for the machine's execs and file transfers
 * to finish before going ahead anyway.
 */
export const LEASE_GRACE_MS = 30_000;

/** States in which a machine's VM may be running and should be stopped. */
const ACTIVE_STATES = new Set(["running", "starting"]);

/**
 * The engine's exec takes no stdin, so stage it in a guest file only root and
 * the command's user can read, redirect it in with `/bin/sh`, and remove the
 * file after. Images must provide `/bin/sh`, as the providers already assume.
 */
async function execWithStdin(
  handle: NativeMachine,
  request: ExecRequest,
  exec: (
    handle: NativeMachine,
    command: string[],
    options?: { env?: EnvVar[]; workdir?: string; user?: string },
  ) => Promise<ExecResult>,
): Promise<ExecResult> {
  const file = `/tmp/.amika-hostd-stdin-${randomUUID()}`;
  try {
    // Inside the try: a write that fails partway may still leave the file.
    await native(() =>
      handle.writeFile(file, Buffer.from(request.stdin ?? ""), {
        mode: 0o600,
      }),
    );
    const owner = await exec(
      handle,
      ["/bin/sh", "-c", 'echo "$(id -u):$(id -g)"'],
      {
        user: request.user,
      },
    );
    const ids = owner.stdout.trim();
    if (owner.exitCode !== 0 || !/^\d+:\d+$/.test(ids)) {
      throw new RuntimeError(500, "cannot resolve the exec user");
    }
    if (
      ids !== "0:0" &&
      (await exec(handle, ["chown", ids, file], { user: "root" })).exitCode !==
        0
    ) {
      throw new RuntimeError(500, "cannot hand stdin to the exec user");
    }
    return await exec(
      handle,
      ["/bin/sh", "-c", 'exec "$@" < "$0"', file, ...request.command],
      request,
    );
  } finally {
    await exec(handle, ["rm", "-f", file], { user: "root" }).catch(() => {});
  }
}

function isOwned(machine: NativeMachineSummary): boolean {
  return machine.labels[LABELS.owner] === "1";
}

function info(machine: NativeMachineSummary, state: string): MachineInfo {
  const { labels } = machine;
  const number = (key: string, fallback: number) => {
    const value = Number(labels[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  const ports = portsLabelSchema.safeParse(labels[LABELS.ports] ?? "");
  return {
    name: machine.name,
    state,
    cpus: number(LABELS.cpus, DEFAULT_CPUS),
    memoryMb: number(LABELS.memoryMb, DEFAULT_MEMORY_MB),
    storageGb: number(LABELS.storageGb, DEFAULT_STORAGE_GB),
    ports: ports.success ? ports.data : [],
  };
}

/**
 * Run a native call, turning the engine's `[CODE] message` errors into
 * `RuntimeError`s with the status `smolvm serve` answered for each.
 */
async function native<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = /^\[([A-Z_]+)\]/.exec(message)?.[1];
    throw new RuntimeError(STATUS_BY_CODE[code ?? ""] ?? 500, message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  CONFIG_ERROR: 400,
  MOUNT_ERROR: 400,
  KVM_UNAVAILABLE: 503,
  HYPERVISOR_UNAVAILABLE: 503,
};
