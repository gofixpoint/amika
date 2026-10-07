/**
 * The machine API's runtime: the `smol` sandbox provider from
 * `@amika/sandbox`, talking to the `smolvm serve` process hostd runs
 * (`./smolvm-serve.ts`).
 *
 * Create, delete, file writes and service ports go through the provider's
 * resource surface. Machine info, start and stop, exec and file reads go
 * through the provider's exported smolvm client instead, so they behave
 * exactly as smolvm's own API: the resource surface reports no published
 * ports, answers a start or stop with nothing, takes exec as a root shell
 * string and reads files as text, while the machine API's contract carries
 * ports and the machine a start or stop leaves, argv with any user, and
 * arbitrary bytes, streamed.
 */
import smolProvider, {
  SmolApiError,
  SmolClient,
  execSchema,
  filePath,
  machinePath,
  machineSchema,
} from "@amika/sandbox/smol";
import { z } from "zod";

/** A machine as the machine API reports it, in `smolvm serve`'s shape. */
export interface MachineInfo {
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  /** Absent on smolvm versions that predate it. */
  storageGb?: number;
  /** Published guest ports and the host ports they are reached on. */
  ports: { host: number; guest: number }[];
}

/**
 * A file's bytes as smolvm streams them, and the type it gave them (JSON for
 * a directory). Streamed, so hostd never holds a whole file in memory.
 */
export interface FileContents {
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
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
  /** Exec and file access boot a stopped machine first, as smolvm's do. */
  exec(name: string, request: ExecRequest): Promise<ExecResult>;
  readFile(name: string, path: string): Promise<FileContents>;
  writeFile(name: string, path: string, data: Uint8Array): Promise<void>;
  /** Refuse (409) services on ports the machine did not publish at create. */
  checkServices(name: string, services: ServicePort[]): Promise<void>;
  /** The host port a running machine publishes `guestPort` on, or null. */
  hostPort(name: string, guestPort: number): Promise<number | null>;
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

export interface ProviderRuntimeConfig {
  /** Where the `smolvm serve` hostd started listens. */
  apiUrl: string;
  /** How long one smolvm request may take, an image pull included. */
  requestTimeoutMs?: number;
  /** Reaches smolvm; tests inject a fake. */
  fetch?: typeof fetch;
}

/** smolvm's defaults, for a create that sizes only some dimensions. */
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY_MB = 8192;
const DEFAULT_STORAGE_GB = 20;

/**
 * The machine runtime over the `smol` provider. The provider's network
 * setting is per provider, so there is one for each; both reach the same
 * smolvm.
 */
export function providerRuntime({
  apiUrl,
  requestTimeoutMs,
  fetch: baseFetch = fetch,
}: ProviderRuntimeConfig): MachineRuntime {
  // Never follow a redirect from smolvm: it would resend exec bodies
  // (commands, environment, stdin) and uploaded files to wherever it points.
  const fetcher: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, redirect: "error" });
  const provider = (network: boolean) =>
    smolProvider({ apiUrl, network, requestTimeoutMs }, fetcher);
  const providers = { networked: provider(true), offline: provider(false) };
  const { sandboxes } = providers.networked;
  const client = new SmolClient({ apiUrl, requestTimeoutMs }, fetcher);
  /**
   * Run a provider call, passing on smolvm's status for a request it
   * refused, as hostd did when it forwarded requests itself.
   */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SmolApiError) {
        throw new RuntimeError(error.status, message);
      }
      // The request's deadline (`AbortSignal.timeout`) or an unreachable
      // smolvm.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RuntimeError(504, message);
      }
      if (error instanceof TypeError) throw new RuntimeError(502, message);
      throw new RuntimeError(500, message);
    }
  };
  const describe = async (name: string): Promise<MachineInfo> =>
    info(await call(() => client.json(machinePath(name), machineSchema)));

  return {
    list: async () =>
      (await call(() => client.json("", machinesSchema))).machines.map(info),
    get: describe,
    create: async (machine) => {
      const sized =
        machine.cpus !== undefined ||
        machine.memoryMb !== undefined ||
        machine.storageGb !== undefined;
      const { sandboxes: target } = machine.network
        ? providers.networked
        : providers.offline;
      await call(() =>
        target.create(CTX, {
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
    // smolvm answers a start or stop with the machine, so a successful one
    // never hinges on a second request: a failed read-back would report a
    // running machine as not started, and a create through hostd would then
    // delete it.
    start: async (name) =>
      info(
        await call(() =>
          client.json(`${machinePath(name)}/start`, machineSchema, "POST"),
        ),
      ),
    stop: async (name) =>
      info(
        await call(() =>
          client.json(`${machinePath(name)}/stop`, machineSchema, "POST"),
        ),
      ),
    remove: async (name) => {
      // The provider treats a missing machine as already deleted; answer
      // 404 for one anyway, as `smolvm serve` does.
      await describe(name);
      await call(() => sandboxes.get(name).delete());
    },
    // Through the client, not the resource surface, which takes a shell
    // string and always runs as root: the machine API takes argv and any
    // user, and forwards both to smolvm unchanged.
    exec: (name, request) =>
      call(() =>
        client.json(`${machinePath(name)}/exec`, execSchema, "POST", {
          command: request.command,
          user: request.user,
          workdir: request.workdir,
          env: request.env,
          stdin: request.stdin,
        }),
      ),
    readFile: (name, path) =>
      call(async () => {
        const response = await client.request(filePath(name, path));
        return {
          body: response.body,
          contentType:
            response.headers.get("content-type") ?? "application/octet-stream",
        };
      }),
    writeFile: async (name, path, data) => {
      await call(() => sandboxes.get(name).writeFile(path, Buffer.from(data)));
    },
    checkServices: async (name, services) => {
      // hostd routes by name, so replacing the names never reconciles the
      // provider's routes (which refuses to drop a port smolvm cannot
      // unpublish): a dropped name is simply no longer routed, and its port
      // stays published on loopback, unreachable through hostd. Only a port
      // the machine did not publish is refused; the provider reports a host
      // port just for published ones.
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
  };
}

const machinesSchema = z.object({ machines: z.array(machineSchema) });

function info(machine: z.infer<typeof machineSchema>): MachineInfo {
  return {
    name: machine.name,
    state: machine.state,
    cpus: machine.cpus,
    memoryMb: machine.memoryMb,
    storageGb: machine.storageGb,
    ports: machine.ports ?? [],
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
