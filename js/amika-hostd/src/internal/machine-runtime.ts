/**
 * The machine API's runtime: the `smolvm-sdk` sandbox provider from
 * `@amika/sandbox`, which runs machines on smolvm's engine embedded in this
 * process (the `smolmachines` SDK), so no `smolvm` binary or server runs
 * beside hostd.
 *
 * Routes go through the provider's resource surface (create, start, stop,
 * delete, state, exec, files, services, listing), translated to and from the
 * machine API's `smolvm serve` shapes. The provider's own exported
 * operations cover the one thing its contract does not: stopping every
 * machine on shutdown. Its limitations (published ports must listen within
 * two minutes of boot, among others) are documented in its README.
 */
import smolvmSdkProvider, {
  smolMachines,
  smolvmSdkErrorCode,
  smolvmSdkOperations,
  type SmolMachines,
} from "@amika/sandbox/smolvm-sdk";

/** A machine as the machine API reports it, in `smolvm serve`'s shape. */
export interface MachineInfo {
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  storageGb: number;
}

export interface EnvVar {
  name: string;
  value: string;
}

/** A named guest port a machine serves, routed to by name. */
export interface ServicePort {
  name: string;
  port: number;
}

export interface CreateMachine {
  name: string;
  image: string;
  cpus?: number;
  memoryMb?: number;
  storageGb?: number;
  network: boolean;
  env?: EnvVar[];
  services?: ServicePort[];
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
  /** Create a machine, publishing each service's guest port; it boots too. */
  create(machine: CreateMachine): Promise<MachineInfo>;
  start(name: string): Promise<MachineInfo>;
  stop(name: string): Promise<MachineInfo>;
  remove(name: string): Promise<void>;
  /** Exec and file access boot a stopped machine first, as smolvm's did. */
  exec(name: string, request: ExecRequest): Promise<ExecResult>;
  readFile(name: string, path: string): Promise<Buffer>;
  writeFile(name: string, path: string, data: Uint8Array): Promise<void>;
  /** Refuse (409) services on ports the machine did not publish at create. */
  checkServices(name: string, services: ServicePort[]): Promise<void>;
  /** The host port a running machine publishes `guestPort` on, or null. */
  hostPort(name: string, guestPort: number): Promise<number | null>;
  /** Stop every machine this process runs, keeping their disks. */
  stopAll(): Promise<void>;
}

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

/** smolvm's defaults, for a create that sizes only some dimensions. */
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY_MB = 8192;
const DEFAULT_STORAGE_GB = 20;

/** The provider runs every command as root. */
const ROOT_USERS = new Set(["root", "0", "0:0"]);

/**
 * The machine runtime over the `smolvm-sdk` provider. The provider's network
 * setting is per provider, so there is one for each; both share the SDK, and
 * with it the provider's handles on machines.
 */
export function providerRuntime(
  machines: SmolMachines = smolMachines,
): MachineRuntime {
  const providers = {
    networked: smolvmSdkProvider({ network: true }, machines),
    offline: smolvmSdkProvider({ network: false }, machines),
  };
  const { sandboxes } = providers.networked;
  /**
   * Run a provider call, mapping its errors to the statuses `smolvm serve`
   * answered. A failed boot reports a generic error; when this host cannot
   * run machines at all, say so with 503.
   */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const status = STATUS_BY_CODE[smolvmSdkErrorCode(error)] ?? 500;
      if (status === 500) {
        const host = machines.localAvailability();
        if (!host.available) throw new RuntimeError(503, host.reason);
      }
      throw new RuntimeError(status, message);
    }
  };
  const describe = async (name: string): Promise<MachineInfo> => {
    const listing = (await call(() => sandboxes.list())).find(
      (machine) => machine.providerSandboxId === name,
    );
    if (!listing) throw new RuntimeError(404, `machine ${name} not found`);
    return {
      name,
      state: listing.state,
      cpus: listing.sizing.vcpus,
      memoryMb: listing.sizing.memoryGib * 1024,
      storageGb: listing.sizing.diskGib,
    };
  };

  return {
    list: async () =>
      (await call(() => sandboxes.list())).map((listing) => ({
        name: listing.providerSandboxId,
        state: listing.state,
        cpus: listing.sizing.vcpus,
        memoryMb: listing.sizing.memoryGib * 1024,
        storageGb: listing.sizing.diskGib,
      })),
    get: describe,
    create: async (machine) => {
      const sized =
        machine.cpus !== undefined ||
        machine.memoryMb !== undefined ||
        machine.storageGb !== undefined;
      const provider = machine.network
        ? providers.networked
        : providers.offline;
      await call(() =>
        provider.sandboxes.create(CTX, {
          name: machine.name,
          snapshot: machine.image,
          resources: sized
            ? {
                vcpus: machine.cpus ?? DEFAULT_CPUS,
                memoryGib: (machine.memoryMb ?? DEFAULT_MEMORY_MB) / 1024,
                diskGib: machine.storageGb ?? DEFAULT_STORAGE_GB,
              }
            : undefined,
          envVars:
            machine.env &&
            Object.fromEntries(machine.env.map((e) => [e.name, e.value])),
          services: (machine.services ?? []).map(sandboxService),
        }),
      );
      return describe(machine.name);
    },
    start: async (name) => {
      await call(() => sandboxes.get(name).start());
      return describe(name);
    },
    stop: async (name) => {
      await call(() => sandboxes.get(name).stop());
      return describe(name);
    },
    remove: async (name) => {
      // The provider treats a missing machine as already deleted; answer
      // 404 for one anyway, as `smolvm serve` did.
      await describe(name);
      await call(() => sandboxes.get(name).delete());
    },
    exec: async (name, request) => {
      if (request.user !== undefined && !ROOT_USERS.has(request.user)) {
        throw new RuntimeError(
          400,
          "commands run as root; exec as another user is not supported",
        );
      }
      return call(() =>
        sandboxes.get(name).exec(request.command.map(shellQuote).join(" "), {
          cwd: request.workdir,
          env:
            request.env &&
            Object.fromEntries(request.env.map((e) => [e.name, e.value])),
          input: request.stdin,
        }),
      );
    },
    readFile: async (name, path) => {
      const contents = await call(() => sandboxes.get(name).readFile(path));
      if (contents === null) throw new RuntimeError(404, `${path} not found`);
      return Buffer.from(contents);
    },
    writeFile: async (name, path, data) => {
      await call(() => sandboxes.get(name).writeFile(path, Buffer.from(data)));
    },
    checkServices: async (name, services) => {
      // hostd routes by name, so replacing the names never reconciles the
      // provider's routes (which refuses to drop a port it cannot unpublish):
      // a dropped name is simply no longer routed, and its port stays
      // published on loopback, unreachable through hostd. Only a port the
      // machine did not publish is refused; the provider reports a host port
      // just for published ones.
      const refreshed = await call(async () => {
        await describe(name);
        return sandboxes
          .get(name)
          .services?.refreshAll(services.map(sandboxService));
      });
      const missing = [
        ...new Set(
          (refreshed?.services ?? [])
            .filter((service) => !service.hostPort)
            .map((service) => service.containerPort),
        ),
      ];
      if (missing.length) {
        throw new RuntimeError(
          409,
          `amika-hostd publishes service ports only at create; machine ${name} does not publish ${missing.join(", ")}`,
        );
      }
    },
    hostPort: async (name, guestPort) => {
      try {
        const sandbox = sandboxes.get(name);
        // A stopped machine's VM no longer holds its host port, so another
        // machine or process may have bound it since.
        if ((await sandbox.getState()) !== "running") return null;
        const refreshed = await sandbox.services?.refreshAll([
          sandboxService({ name: "route", port: guestPort }),
        ]);
        return refreshed?.services[0]?.hostPort || null;
      } catch {
        return null;
      }
    },
    stopAll: () => smolvmSdkOperations({}, machines).stopAll(),
  };
}

/** A service as the provider takes it; the provider fills in host and URL. */
function sandboxService({ name, port }: ServicePort) {
  return {
    name,
    containerPort: port,
    hostPort: 0,
    url: "",
    protocol: "tcp" as const,
  };
}

/** Quote one argv entry for the provider's `/bin/sh -c`. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The provider's create takes a request context; hostd logs nothing there. */
const CTX = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => CTX.logger,
  },
  childCtx: () => CTX,
};

/** The status `smolvm serve` answered for each engine error code. */
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  CONFIG_ERROR: 400,
  INVALID_CONFIG: 400,
  MOUNT_ERROR: 400,
  KVM_UNAVAILABLE: 503,
  HYPERVISOR_UNAVAILABLE: 503,
  // A published port that never accepted connections (see the provider's
  // README).
  TIMEOUT: 504,
};
