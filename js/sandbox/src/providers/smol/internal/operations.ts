/** Local machine lifecycle and provisioning primitives over smolvm serve. */
import { createServer } from "node:net";
import { z } from "zod";
import type { SmolConfig } from "../config";
import {
  SandboxProviderUnsupportedError,
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type ReadFileBytesOptions,
  type RefreshUrlsResult,
  type SandboxResources,
} from "../../provider";
import type { SandboxService } from "../../../types";
import { DEFAULT_HOME_DIR } from "../../../constants";
import { shellQuote } from "../../../util/shell";
import { decodeUtf8, execFailureText } from "../../shared/adapter";
import type { SandboxAdapter } from "../../shared/adapter";
import { readCapped } from "../../shared/capped-read";
import type { SandboxStatus } from "../../../sandbox-status";
import {
  SmolApiError,
  SmolClient,
  execSchema,
  filePath,
  machinePath,
  machineSchema,
} from "./client";

export interface SmolOperationsOptions {
  /** The provider named in created sandboxes and unsupported-operation errors. */
  provider?: string;
  /**
   * Send the runtime each service's route name and guest port instead of
   * publishing ports. Only amika-hostd, which picks the host side of each
   * port and routes to it by name, sets this; for plain smolvm the provider
   * picks host ports and publishes them itself.
   */
  serviceRoutes?: (
    services: CreateSandboxProviderInput["services"],
  ) => { name: string; port: number }[];
}

/**
 * A create, whose resources may name only some sizes: smolvm picks each one
 * left out, from the image's manifest when it has one (a packed image's or a
 * checkpoint's own sizes) or its defaults. The provider interface always
 * passes all three; amika-hostd forwards a request's partial sizes as given.
 */
export type SmolCreateInput = Omit<CreateSandboxProviderInput, "resources"> & {
  resources?: Partial<SandboxResources>;
  /**
   * A `.smolmachine` or checkpoint artifact on the runtime's own host to
   * boot from, instead of pulling `snapshot` as an OCI image. smolvm takes
   * the two as mutually exclusive, so `snapshot` is ignored when this is
   * set. Only amika-hostd uses it, to boot a rig from a local snapshot.
   */
  from?: string;
};

/**
 * The unprivileged user Amika images provision, which ordinary execs and file
 * writes run as so repos, agent configs, and credentials land in its home and
 * are owned by it, as on the cloud providers. `sudo: true` runs as root.
 */
const AMIKA_USER = "amika";

export function smolOperations(
  config: SmolConfig,
  client = new SmolClient(config),
  { provider = "smol", serviceRoutes }: SmolOperationsOptions = {},
) {
  const rejectTimer = (
    interval: number | null | undefined,
    operation: string,
  ): void => {
    if (interval != null && interval !== 0)
      throw new SandboxProviderUnsupportedError(provider, operation);
  };
  const adapter = (id: string): SandboxAdapter => ({
    exec: (command, opts) => run(id, command, opts),
    uploadFile: (content, path) => write(id, path, content),
    downloadFile: async (path) => {
      const bytes = await read(id, path);
      return bytes === null ? null : decodeUtf8(bytes);
    },
  });
  const run = (id: string, command: string, opts?: ExecCommandOptions) =>
    client.json(`${machinePath(id)}/exec`, execSchema, "POST", {
      command: ["/bin/sh", "-c", command],
      user: opts?.sudo ? "root" : AMIKA_USER,
      workdir: opts?.cwd,
      // Named explicitly rather than trusting the runtime to derive it from
      // the user, so a command never writes into another user's home; a
      // caller's own HOME still wins.
      env: Object.entries({
        HOME: opts?.sudo ? "/root" : DEFAULT_HOME_DIR,
        ...opts?.env,
      }).map(([name, value]) => ({ name, value })),
      stdin: opts?.input,
    });
  /**
   * smolvm's files API writes as root and creates missing parents as root, so
   * create the parent as the exec user first, then hand the file to that
   * user, as Freestyle's adapter does. A parent that user cannot create (a
   * system path) is left to the write; a request that fails outright fails
   * the write. A file left root-owned breaks the lifecycle's later work on it
   * as that user (`chmod 600 ~/.git-credentials`, the agent reading its
   * config), so a failed chown fails the write. `chown -h` changes a symlink
   * itself, never its target, so a link planted at the path cannot hand the
   * exec user a file elsewhere.
   */
  const write = async (
    id: string,
    path: string,
    content: Buffer | string,
  ): Promise<void> => {
    // Validated before any exec, so a bad path never reaches the shell.
    const url = filePath(id, path);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await run(id, `mkdir -p -- ${shellQuote(dir)}`);
    await client.discard(
      url,
      "PUT",
      Buffer.isBuffer(content) ? content : Buffer.from(content),
    );
    const chown = await run(
      id,
      `chown -h -- ${AMIKA_USER}:${AMIKA_USER} ${shellQuote(path)}`,
      { sudo: true },
    );
    if (chown.exitCode !== 0) {
      throw new Error(
        `Failed to chown ${path} to ${AMIKA_USER}: ${execFailureText(chown)}`,
      );
    }
  };
  const read = async (
    id: string,
    path: string,
    opts?: ReadFileBytesOptions,
  ): Promise<Uint8Array | null> => {
    try {
      const response = await client.request(filePath(id, path));
      if (
        !response.headers
          .get("content-type")
          ?.startsWith("application/octet-stream")
      ) {
        await response.body?.cancel();
        throw new Error(
          "smolvm returned a directory or an unexpected file content type",
        );
      }
      if (!response.body) return new Uint8Array();
      return await readCapped(response.body, path, opts?.maxBytes);
    } catch (error) {
      if (error instanceof SmolApiError && error.status === 404) return null;
      throw error;
    }
  };
  const remove = async (id: string) => {
    try {
      await client.discard(machinePath(id), "DELETE");
    } catch (error) {
      if (!(error instanceof SmolApiError && error.status === 404)) throw error;
    }
  };
  /** The machine's published ports, guest to host. */
  const publishedPorts = async (id: string) =>
    (await client.json(machinePath(id), machineSchema)).ports ?? [];
  /**
   * Publish exactly `guestPorts` on a machine, running or not, keeping the
   * host port of each one already published and picking a free loopback
   * port for each new one. smolvm takes the whole list and unpublishes any
   * port left out; a TCP change applies to a running machine at once.
   */
  const publishPorts = async (id: string, guestPorts: number[]) => {
    const published = await publishedPorts(id);
    const wanted = [...new Set(guestPorts)];
    if (
      wanted.length === published.length &&
      wanted.every((guest) => published.some((p) => p.guest === guest))
    ) {
      return;
    }
    const ports = await Promise.all(
      wanted.map(
        async (guest) =>
          published.find((p) => p.guest === guest) ?? {
            host: await freeLoopbackPort(),
            guest,
          },
      ),
    );
    await client.discard(`${machinePath(id)}/ports`, "PUT", { ports });
  };
  const start = async (id: string, interval?: number | null) => {
    rejectTimer(interval, "autoStopInterval");
    await client.discard(`${machinePath(id)}/start`, "POST");
  };

  return {
    adapter,
    run,
    read,
    write,
    create: async (input: SmolCreateInput): Promise<CreatedProviderSandbox> => {
      machinePath(input.name);
      if (!input.from && !input.snapshot.trim())
        throw new Error("Smol requires an OCI image in snapshot");
      if (input.services.some((service) => service.protocol !== "tcp"))
        throw new SandboxProviderUnsupportedError(provider, "udp services");
      rejectTimer(input.autoStopInterval, "autoStopInterval");
      rejectTimer(input.autoDeleteInterval, "autoDeleteInterval");
      const resources =
        input.resources &&
        z
          .object({
            // smolvm's limits (`VmResources::validate`): it supports at most
            // 16 vCPUs (only macOS actually caps there; we refuse more on
            // every host) and can't boot a VM with under 64 MiB.
            vcpus: z.number().int().min(1).max(16).optional(),
            memoryGib: z
              .number()
              .min(64 / 1024)
              .refine((n) => Number.isSafeInteger(n * 1024))
              .optional(),
            diskGib: z.number().int().positive().optional(),
          })
          .parse(input.resources);
      // For plain smolvm, publish each service's guest port on a host
      // loopback port picked here, so a caller can never bind an arbitrary
      // host port. amika-hostd publishes them itself, by name.
      const ports =
        input.services.length && !serviceRoutes
          ? await Promise.all(
              [...new Set(input.services.map((s) => s.containerPort))].map(
                async (guest) => ({ host: await freeLoopbackPort(), guest }),
              ),
            )
          : undefined;
      // Create does not boot. Only delete after create succeeds, so a name
      // conflict never causes us to delete an existing machine.
      await client.discard("", "POST", {
        name: input.name,
        // smolvm refuses both together, so an artifact create sends no image.
        image: input.from ? undefined : input.snapshot,
        from: input.from,
        cpus: resources?.vcpus,
        memoryMb:
          resources?.memoryGib === undefined
            ? undefined
            : resources.memoryGib * 1024,
        storageGb: resources?.diskGib,
        network: config.network ?? false,
        env: Object.entries(input.envVars ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
        services:
          input.services.length && serviceRoutes
            ? uniqueByName(serviceRoutes(input.services))
            : undefined,
        ports,
      });
      try {
        await start(input.name);
      } catch (error) {
        try {
          await remove(input.name);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Smol start and cleanup failed",
          );
        }
        throw error;
      }
      return {
        provider,
        providerSandboxId: input.name,
        services: ports ? withHostPorts(input.services, ports) : input.services,
        envVars: input.envVars,
      };
    },
    remove,
    /** Each service with the host port and local URL its guest port maps to. */
    refreshUrls: async (
      id: string,
      services: SandboxService[],
    ): Promise<RefreshUrlsResult> => ({
      services: withHostPorts(services, await publishedPorts(id)),
    }),
    publishPorts,
    /** Publish exactly the desired services' ports, unpublishing any other. */
    syncRoutes: async (id: string, desired: SandboxService[]) => {
      if (desired.some((service) => service.protocol !== "tcp"))
        throw new SandboxProviderUnsupportedError(provider, "udp services");
      await publishPorts(
        id,
        desired.map((service) => service.containerPort),
      );
    },
    start,
    stop: (id: string) => client.discard(`${machinePath(id)}/stop`, "POST"),
    getState: async (id: string) => {
      try {
        return (await client.json(machinePath(id), machineSchema)).state;
      } catch (error) {
        if (error instanceof SmolApiError && error.status === 404)
          return "unknown";
        throw error;
      }
    },
    list: async () => {
      const { machines } = await client.json(
        "",
        z.object({ machines: z.array(machineSchema) }),
      );
      return machines.flatMap((machine) =>
        machine.storageGb === undefined
          ? []
          : [
              {
                providerSandboxId: machine.name,
                orgId: null,
                state: machine.state,
                sizing: {
                  vcpus: machine.cpus,
                  memoryGib: machine.memoryMb / 1024,
                  diskGib: machine.storageGb,
                },
              },
            ],
      );
    },
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
 * It is released before smolvm binds it, so another process can take it
 * first, and the machine then fails to start or the publish fails.
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

export function mapSmolState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "created":
      return "creating";
    case "started":
      return "starting";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/** One route per name: the same service listed twice is published once. */
function uniqueByName<T extends { name: string }>(routes: T[]): T[] {
  return [...new Map(routes.map((route) => [route.name, route])).values()];
}
