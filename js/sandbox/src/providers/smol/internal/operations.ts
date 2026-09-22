/** Local machine lifecycle and provisioning primitives over smolvm serve. */
import { z } from "zod";
import type { SmolConfig } from "../config";
import {
  SandboxProviderUnsupportedError,
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
} from "../../provider";
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

export function smolOperations(
  config: SmolConfig,
  client = new SmolClient(config),
  provider: "smol" | "amika-hostd" = "smol",
) {
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
  const start = async (id: string, interval?: number | null) => {
    rejectTimer(provider, interval, "autoStopInterval");
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
        throw new Error(`${provider} requires an OCI image in snapshot`);
      if (input.services.length)
        throw new SandboxProviderUnsupportedError(provider, "services");
      rejectTimer(provider, input.autoStopInterval, "autoStopInterval");
      rejectTimer(provider, input.autoDeleteInterval, "autoDeleteInterval");
      const resources =
        input.resources &&
        z
          .object({
            vcpus: z.number().int().min(1).max(255),
            memoryGib: z
              .number()
              .positive()
              .refine((n) => Number.isSafeInteger(n * 1024)),
            diskGib: z.number().int().positive(),
          })
          .parse(input.resources);
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
      });
      try {
        await start(input.name);
      } catch (error) {
        try {
          await remove(input.name);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${provider} start and cleanup failed`,
          );
        }
        throw error;
      }
      return {
        provider,
        providerSandboxId: input.name,
        services: [],
        envVars: input.envVars,
      };
    },
    remove,
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

export function mapSmolState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "created":
      return "creating";
    case "started":
      return "starting";
    case "stopped":
      return "suspended";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function rejectTimer(
  provider: "smol" | "amika-hostd",
  interval: number | null | undefined,
  operation: string,
): void {
  if (interval != null && interval !== 0)
    throw new SandboxProviderUnsupportedError(provider, operation);
}
