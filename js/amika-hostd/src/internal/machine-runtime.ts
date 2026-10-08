/**
 * The machine API's runtime: the `smol` sandbox provider from
 * `@amika/sandbox`, talking to the `smolvm serve` process hostd runs
 * (`./smolvm-serve.ts`).
 *
 * Create goes through the provider's create operation, which takes a
 * request's sizes as given. Delete, file writes and service ports go through
 * the provider's resource surface. Machine info, start and stop, exec and file reads go
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
  smolOperations,
} from "@amika/sandbox/smol";
import { z } from "zod";

/**
 * A machine as the machine API reports it: `smolvm serve`'s whole object,
 * every field it sends (image, network, mounts, ...) passed through.
 */
export interface MachineInfo {
  [field: string]: unknown;
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

/** smolvm's exec result, every field it sends passed through. */
export interface ExecResult {
  [field: string]: unknown;
  exitCode: number;
  /** Decoded as UTF-8, lossily; `stdoutB64` carries the exact bytes. */
  stdout: string;
  stderr: string;
  stdoutB64?: string;
  stderrB64?: string;
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
    /**
     * smolvm's own reason, one line and capped, when the machine API may
     * pass it on: never an exec's, which may echo the command, nor one
     * that repeats a value the request sent in confidence.
     */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The longest smolvm reason the machine API passes on. */
export const MAX_REASON_LENGTH = 500;

/** smolvm's reason as one line, cut to `MAX_REASON_LENGTH`. */
function surfaceable(reason: string | undefined): string | undefined {
  const line = reason?.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_REASON_LENGTH
    ? `${line.slice(0, MAX_REASON_LENGTH - 1)}…`
    : line;
}

/** Drop a failure's reason if it repeats any of `secrets`. */
function withoutSecrets(error: unknown, secrets: string[]): unknown {
  if (
    error instanceof RuntimeError &&
    error.reason !== undefined &&
    secrets.some((secret) => secret && error.reason?.includes(secret))
  ) {
    return new RuntimeError(error.status, error.message);
  }
  return error;
}

export interface ProviderRuntimeConfig {
  /** Where the `smolvm serve` hostd started listens. */
  apiUrl: string;
  /** How long one smolvm request may take, an image pull included. */
  requestTimeoutMs?: number;
  /** Reaches smolvm; tests inject a fake. */
  fetch?: typeof fetch;
}

/**
 * The machine runtime over the `smol` provider. The provider's network
 * setting is per provider, so create has one set of operations for each; all
 * reach the same smolvm.
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
  const { sandboxes } = smolProvider({ apiUrl, requestTimeoutMs }, fetcher);
  const client = new SmolClient({ apiUrl, requestTimeoutMs }, fetcher);
  // The resource surface's create takes all three sizes or none; these
  // operations take only those a request names, so smolvm still picks the
  // rest from the image (a packed image's or a checkpoint's own sizes).
  const creators = {
    networked: smolOperations(
      { apiUrl, network: true, requestTimeoutMs },
      client,
    ),
    offline: smolOperations(
      { apiUrl, network: false, requestTimeoutMs },
      client,
    ),
  };
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
        throw new RuntimeError(
          error.status,
          message,
          surfaceable(error.reason),
        );
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
    info(await call(() => client.json(machinePath(name), smolvmMachine)));

  return {
    list: async () =>
      (await call(() => client.json("", machinesSchema))).machines.map(info),
    get: describe,
    create: async (machine) => {
      const target = machine.network ? creators.networked : creators.offline;
      // smolvm's reason for a refused create could repeat an environment
      // value, so one that does is not passed on.
      await call(() =>
        target.create({
          name: machine.name,
          snapshot: machine.image,
          resources: {
            vcpus: machine.cpus,
            memoryGib:
              machine.memoryMb === undefined
                ? undefined
                : machine.memoryMb / 1024,
            diskGib: machine.storageGb,
          },
          envVars:
            machine.env &&
            Object.fromEntries(machine.env.map((e) => [e.name, e.value])),
          services: (machine.services ?? []).map(sandboxService),
        }),
      ).catch((error: unknown) => {
        throw withoutSecrets(
          error,
          (machine.env ?? []).map((e) => e.value),
        );
      });
      return describe(machine.name);
    },
    // smolvm answers a start or stop with the machine, so a successful one
    // never hinges on a second request: a failed read-back would report a
    // running machine as not started, and a create through hostd would then
    // delete it.
    start: async (name) =>
      info(
        await call(() =>
          client.json(`${machinePath(name)}/start`, smolvmMachine, "POST"),
        ),
      ),
    stop: async (name) =>
      info(
        await call(() =>
          client.json(`${machinePath(name)}/stop`, smolvmMachine, "POST"),
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
        client.json(`${machinePath(name)}/exec`, smolvmExec, "POST", {
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

/**
 * smolvm's replies, validated for what hostd reads and otherwise passed
 * through whole: the machine API answers in `smolvm serve`'s shapes, so a
 * field hostd does not know of (a machine's image or network, exec's exact
 * output bytes) still reaches the caller.
 */
const smolvmMachine = machineSchema.loose();
const smolvmExec = execSchema.loose();
const machinesSchema = z.object({ machines: z.array(smolvmMachine) });

function info(machine: z.infer<typeof smolvmMachine>): MachineInfo {
  return { ...machine, ports: machine.ports ?? [] };
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
