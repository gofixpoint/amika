/** Local machine lifecycle and provisioning primitives over smolvm serve. */
import { createServer } from "node:net";
import { z } from "zod";
import type { SmolConfig } from "../config";
import {
  SandboxProviderUnsupportedError,
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type RefreshUrlsResult,
} from "../../provider";
import type { SandboxService } from "../../../types";
import type { SandboxAdapter } from "../../shared/adapter";
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
    downloadFile: (path) => read(id, path),
  });
  const run = (id: string, command: string, opts?: ExecCommandOptions) =>
    client.json(`${machinePath(id)}/exec`, execSchema, "POST", {
      command: ["/bin/sh", "-c", command],
      user: "root",
      workdir: opts?.cwd,
      env: Object.entries(opts?.env ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
      stdin: opts?.input,
    });
  const write = (id: string, path: string, content: Buffer | string) =>
    client.discard(
      filePath(id, path),
      "PUT",
      Buffer.isBuffer(content) ? content : Buffer.from(content),
    );
  const read = async (id: string, path: string): Promise<string | null> => {
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
      return await response.text();
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
  const start = async (id: string, interval?: number | null) => {
    rejectTimer(interval, "autoStopInterval");
    await client.discard(`${machinePath(id)}/start`, "POST");
  };

  return {
    adapter,
    run,
    read,
    write,
    create: async (
      input: CreateSandboxProviderInput,
    ): Promise<CreatedProviderSandbox> => {
      machinePath(input.name);
      if (!input.snapshot.trim())
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
            vcpus: z.number().int().min(1).max(16),
            memoryGib: z
              .number()
              .min(64 / 1024)
              .refine((n) => Number.isSafeInteger(n * 1024)),
            diskGib: z.number().int().positive(),
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
        image: input.snapshot,
        cpus: resources?.vcpus,
        memoryMb: resources && resources.memoryGib * 1024,
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
    /**
     * smolvm publishes ports only at create and cannot unpublish one, so the
     * routes already match the desired services exactly when their ports are
     * the published ones; anything else is refused rather than reported done.
     */
    syncRoutes: async (id: string, desired: SandboxService[]) => {
      if (desired.some((service) => service.protocol !== "tcp"))
        throw new SandboxProviderUnsupportedError(provider, "udp services");
      const published = new Set((await publishedPorts(id)).map((p) => p.guest));
      const wanted = new Set(desired.map((s) => s.containerPort));
      const missing = [...wanted].filter((p) => !published.has(p));
      const dropped = [...published].filter((p) => !wanted.has(p));
      if (missing.length) {
        throw new SmolPortsError(
          `smolvm publishes service ports only at create; machine ${id} does not publish ${missing.join(", ")}`,
        );
      }
      if (dropped.length) {
        throw new SmolPortsError(
          `smolvm cannot unpublish ports; machine ${id} still publishes ${dropped.join(", ")}`,
        );
      }
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

/**
 * A route reconcile smolvm cannot carry out: it publishes ports only at
 * create and never unpublishes one.
 */
export class SmolPortsError extends Error {
  override name = "SmolPortsError";
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
 * first, and the machine then fails to start.
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
