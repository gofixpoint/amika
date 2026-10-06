/** Local machine operations over the embedded smolvm engine's public API. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { MachineSummary } from "smolmachines";
import { z } from "zod";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxStatus } from "../../../sandbox-status";
import type { SandboxService } from "../../../types";
import {
  SandboxProviderUnsupportedError,
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type ProviderSandboxListing,
  type RefreshUrlsResult,
  type SandboxExecResult,
} from "../../provider";
import type { SandboxAdapter } from "../../shared/adapter";
import type { SmolvmSdkConfig } from "../config";
import {
  LOCAL,
  smolErrorCode,
  smolMachines,
  type SmolMachine,
  type SmolMachines,
} from "./client";

const PROVIDER = "smolvm-sdk";

/**
 * A machine this provider does not own, or that does not exist. Carries the
 * SDK's `NOT_FOUND` code so callers map it like an SDK error.
 */
export class SmolvmSdkNotFoundError extends Error {
  override name = "SmolvmSdkNotFoundError";
  readonly code = "NOT_FOUND";
  constructor(id: string) {
    super(`smolvm machine ${id} not found`);
  }
}

/**
 * A service on a port the machine did not publish at create: the engine
 * publishes ports only then. Carries a `CONFLICT` code.
 */
export class SmolvmSdkUnpublishedPortError extends Error {
  override name = "SmolvmSdkUnpublishedPortError";
  readonly code = "CONFLICT";
  constructor(id: string, ports: number[]) {
    super(
      `smolvm machines publish service ports only at create; machine ${id} does not publish ${ports.join(", ")}`,
    );
  }
}

/**
 * A route reconcile that would drop a published port: the engine cannot
 * unpublish one, so its forward would keep accepting connections. Carries a
 * `CONFLICT` code.
 */
export class SmolvmSdkUnrevocablePortError extends Error {
  override name = "SmolvmSdkUnrevocablePortError";
  readonly code = "CONFLICT";
  constructor(id: string, ports: number[]) {
    super(
      `smolvm machines cannot unpublish ports; machine ${id} still publishes ${ports.join(", ")}`,
    );
  }
}

/** The host cannot run machines (no KVM, say). Carries the SDK's code. */
export class SmolvmSdkUnavailableError extends Error {
  override name = "SmolvmSdkUnavailableError";
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * Labels stored with each machine. The engine's database is shared with the
 * `smol` CLI and every other embedder on the host, so the owner label keeps
 * this provider to its own machines; the rest record what `Machine.list`
 * does not report, so a machine can be described without booting it.
 */
const LABELS = {
  owner: "amika-smolvm-sdk",
  cpus: "amika-smolvm-sdk.cpus",
  memoryMb: "amika-smolvm-sdk.memory-mb",
  storageGb: "amika-smolvm-sdk.storage-gb",
  ports: "amika-smolvm-sdk.ports",
} as const;
const OWNED = { labels: { [LABELS.owner]: "1" } };

/** smolvm's defaults (`VmResources`, `DEFAULT_STORAGE_SIZE_GIB`). */
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY_MB = 8192;
const DEFAULT_STORAGE_GB = 20;

/** Commands run as uid 0, which needs no `root` passwd entry in the image. */
const ROOT = "0:0";

/** States in which a machine's VM may be running and can be stopped. */
const ACTIVE_STATES = new Set(["running", "starting"]);

/**
 * Handles on machines, per SDK. The engine's machines are per process, so
 * every provider built over the same SDK shares one cache; a machine with no
 * handle yet (one an earlier process left stopped) is connected on demand.
 */
const handleCaches = new WeakMap<SmolMachines, Map<string, SmolMachine>>();
function handlesFor(machines: SmolMachines): Map<string, SmolMachine> {
  let handles = handleCaches.get(machines);
  if (!handles) {
    handles = new Map();
    handleCaches.set(machines, handles);
  }
  return handles;
}

export function smolvmSdkOperations(
  config: SmolvmSdkConfig,
  machines: SmolMachines = smolMachines,
) {
  const handles = handlesFor(machines);
  const rejectTimer = (interval: number | null | undefined, op: string) => {
    if (interval != null && interval !== 0)
      throw new SandboxProviderUnsupportedError(PROVIDER, op);
  };

  const owned = () => machines.list(LOCAL, OWNED);
  const summary = async (id: string): Promise<MachineSummary> => {
    const found = (await owned()).find((machine) => machine.name === id);
    if (!found) throw new SmolvmSdkNotFoundError(id);
    return found;
  };
  /**
   * A handle on an owned machine, connecting if none is held. `connect`
   * boots a stopped machine and waits for its published ports.
   */
  const handle = async (id: string): Promise<SmolMachine> => {
    await summary(id);
    const held = handles.get(id);
    if (held) return held;
    const machine = await machines.connect(id, LOCAL);
    handles.set(id, machine);
    return machine;
  };
  /** A handle on a running machine, starting it if it is stopped. */
  const running = async (id: string): Promise<SmolMachine> => {
    const { state } = await summary(id);
    const held = handles.get(id);
    if (!held) return handle(id);
    if (state !== "running") await held.start();
    return held;
  };

  const run = async (
    id: string,
    command: string,
    opts?: ExecCommandOptions,
  ): Promise<SandboxExecResult> => {
    const machine = await running(id);
    const options = { env: opts?.env, workdir: opts?.cwd, user: ROOT };
    if (opts?.input === undefined) {
      return execResult(
        await machine.exec(["/bin/sh", "-c", command], options),
      );
    }
    return execWithStdin(machine, command, opts.input, options);
  };
  const read = async (id: string, path: string): Promise<string | null> => {
    try {
      return (await (await running(id)).readFile(path)).toString("utf8");
    } catch (error) {
      if (smolErrorCode(error) === "NOT_FOUND") return null;
      throw error;
    }
  };
  const write = async (
    id: string,
    path: string,
    content: Buffer | string,
  ): Promise<void> => {
    const machine = await running(id);
    await machine.writeFile(
      path,
      Buffer.isBuffer(content) ? content : Buffer.from(content),
    );
  };
  const remove = async (id: string): Promise<void> => {
    let machine: SmolMachine;
    try {
      // The SDK deletes only through a handle, and the only handle on a
      // stopped machine from an earlier run comes from connecting, which
      // boots it.
      machine = await handle(id);
    } catch (error) {
      if (smolErrorCode(error) === "NOT_FOUND") return;
      throw error;
    }
    await machine.delete();
    handles.delete(id);
  };

  return {
    run,
    read,
    write,
    remove,
    adapter: (id: string): SandboxAdapter => ({
      exec: (command, opts) => run(id, command, opts),
      uploadFile: (content, path) => write(id, path, content),
      downloadFile: (path) => read(id, path),
    }),
    create: async (
      input: CreateSandboxProviderInput,
    ): Promise<CreatedProviderSandbox> => {
      if (!input.snapshot.trim())
        throw new Error("smolvm-sdk requires an OCI image in snapshot");
      if (input.services.some((service) => service.protocol !== "tcp"))
        throw new SandboxProviderUnsupportedError(PROVIDER, "udp services");
      rejectTimer(input.autoStopInterval, "autoStopInterval");
      rejectTimer(input.autoDeleteInterval, "autoDeleteInterval");
      const host = machines.localAvailability();
      if (!host.available) {
        throw new SmolvmSdkUnavailableError(host.code, host.reason);
      }
      const resources =
        input.resources && resourcesSchema.parse(input.resources);
      const cpus = resources?.vcpus ?? DEFAULT_CPUS;
      const memoryMb = resources
        ? resources.memoryGib * 1024
        : DEFAULT_MEMORY_MB;
      const storageGb = resources?.diskGib ?? DEFAULT_STORAGE_GB;
      // The provider picks each published port's host side, so a caller can
      // never bind an arbitrary host port.
      const ports = await Promise.all(
        [...new Set(input.services.map((s) => s.containerPort))].map(
          async (guest) => ({ host: await freeLoopbackPort(), guest }),
        ),
      );
      const machine = await machines.create(
        {
          name: input.name,
          image: input.snapshot,
          env: input.envVars,
          ports,
          resources: {
            cpus,
            memoryMb,
            storageGb,
            network: config.network ?? false,
          },
          persistent: true,
          labels: {
            ...input.labels,
            [LABELS.owner]: "1",
            [LABELS.cpus]: String(cpus),
            [LABELS.memoryMb]: String(memoryMb),
            [LABELS.storageGb]: String(storageGb),
            [LABELS.ports]: ports.map((p) => `${p.host}:${p.guest}`).join(","),
          },
        },
        LOCAL,
      );
      handles.set(input.name, machine);
      return {
        provider: PROVIDER,
        providerSandboxId: input.name,
        services: withHostPorts(input.services, ports),
        envVars: input.envVars,
      };
    },
    start: async (id: string, interval?: number | null): Promise<void> => {
      rejectTimer(interval, "autoStopInterval");
      await running(id);
    },
    stop: async (id: string): Promise<void> => {
      const { state } = await summary(id);
      const held = handles.get(id);
      if (held) {
        await held.stop();
      } else if (ACTIVE_STATES.has(state)) {
        // Running without a handle: started by an earlier process that is
        // still shutting down, say.
        await (await handle(id)).stop();
      }
    },
    getState: async (id: string): Promise<string> => {
      try {
        return (await summary(id)).state;
      } catch (error) {
        if (error instanceof SmolvmSdkNotFoundError) return "unknown";
        throw error;
      }
    },
    /** The published ports of an owned machine, guest to host. */
    ports: async (id: string) => publishedPorts(await summary(id)),
    list: async (): Promise<ProviderSandboxListing[]> =>
      (await owned()).map((machine) => {
        const sizes = sizesOf(machine);
        return {
          providerSandboxId: machine.name,
          orgId: machine.labels[SANDBOX_ORG_ID_LABEL] ?? null,
          state: machine.state,
          sizing: {
            vcpus: sizes.cpus,
            memoryGib: sizes.memoryMb / 1024,
            diskGib: sizes.storageGb,
          },
        };
      }),
    refreshUrls: async (
      id: string,
      services: SandboxService[],
    ): Promise<RefreshUrlsResult> => ({
      services: withHostPorts(services, publishedPorts(await summary(id))),
    }),
    syncRoutes: async (
      id: string,
      desired: SandboxService[],
    ): Promise<void> => {
      // Services are reached by the ports published at create, and the
      // engine can neither publish nor unpublish one later. So the routes
      // already match the desired set exactly when its ports are the
      // published ones; anything else is refused rather than reported done.
      // Published forwards are TCP, so a service switched to UDP on the same
      // port would be advertised over a forward that cannot carry it.
      if (desired.some((service) => service.protocol !== "tcp"))
        throw new SandboxProviderUnsupportedError(PROVIDER, "udp services");
      const published = new Set(
        publishedPorts(await summary(id)).map((p) => p.guest),
      );
      const wanted = new Set(desired.map((s) => s.containerPort));
      const missing = [...wanted].filter((p) => !published.has(p));
      if (missing.length) throw new SmolvmSdkUnpublishedPortError(id, missing);
      const dropped = [...published].filter((p) => !wanted.has(p));
      if (dropped.length) throw new SmolvmSdkUnrevocablePortError(id, dropped);
    },
    /** Stop every machine this process holds a handle on, keeping disks. */
    stopAll: async (): Promise<void> => {
      await Promise.allSettled(
        [...handles.values()].map((machine) => machine.stop()),
      );
    },
  };
}

export function mapSmolvmSdkState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    // Paused through the `smol` CLI or the SDK: execution saved, VM stopped.
    case "pausing":
      return "suspending";
    case "paused":
      return "suspended";
    case "stopped":
      return "stopped";
    case "created":
      return "creating";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * The SDK's exec takes no stdin, so stage it in a guest file only root can
 * read, redirect it in with `/bin/sh`, and remove the file after. Commands
 * run as root, so the file needs no other owner. Images must provide
 * `/bin/sh`, which every command here already runs under.
 */
async function execWithStdin(
  machine: SmolMachine,
  command: string,
  input: string,
  options: { env?: Record<string, string>; workdir?: string; user: string },
): Promise<SandboxExecResult> {
  const file = `/tmp/.amika-stdin-${randomUUID()}`;
  try {
    // Inside the try: a write that fails partway may still leave the file.
    await machine.writeFile(file, Buffer.from(input), 0o600);
    return execResult(
      await machine.exec(
        ["/bin/sh", "-c", 'exec /bin/sh -c "$1" < "$0"', file, command],
        options,
      ),
    );
  } finally {
    await machine
      .exec(["rm", "-f", file], { user: options.user })
      .catch(() => {});
  }
}

/**
 * The provider contract's result: the SDK's carries byte copies of both
 * streams, truncation flags and helpers besides, which a caller serializing
 * the result must not emit.
 */
function execResult({
  exitCode,
  stdout,
  stderr,
}: SandboxExecResult): SandboxExecResult {
  return { exitCode, stdout, stderr };
}

/**
 * smolvm's limits (`VmResources::validate`): at most 16 vCPUs (only macOS
 * actually caps there; we refuse more on every host), and no VM under 64 MiB.
 */
const resourcesSchema = z.object({
  vcpus: z.number().int().min(1).max(16),
  memoryGib: z
    .number()
    .min(64 / 1024)
    .refine((n) => Number.isSafeInteger(n * 1024)),
  diskGib: z.number().int().positive(),
});

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

function publishedPorts(
  machine: MachineSummary,
): { host: number; guest: number }[] {
  const ports = portsLabelSchema.safeParse(machine.labels[LABELS.ports] ?? "");
  return ports.success ? ports.data : [];
}

function sizesOf(machine: MachineSummary) {
  const number = (key: string, fallback: number) => {
    const value = Number(machine.labels[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    cpus: number(LABELS.cpus, DEFAULT_CPUS),
    memoryMb: number(LABELS.memoryMb, DEFAULT_MEMORY_MB),
    storageGb: number(LABELS.storageGb, DEFAULT_STORAGE_GB),
  };
}

/** Services with the host port and local URL each one's guest port maps to. */
function withHostPorts(
  services: SandboxService[],
  ports: { host: number; guest: number }[],
): SandboxService[] {
  return services.map((service) => {
    const host = ports.find((p) => p.guest === service.containerPort)?.host;
    return host === undefined
      ? service
      : {
          ...service,
          hostPort: host,
          url: `${service.urlScheme ?? "http"}://127.0.0.1:${host}`,
        };
  });
}

/**
 * A free port on the host's loopback interface to publish a guest port on.
 * It is released before the machine binds it, so another process can take
 * it first, and the machine then fails to start.
 */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}
