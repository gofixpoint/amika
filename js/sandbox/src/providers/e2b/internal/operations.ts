import {
  CommandExitError,
  FileNotFoundError,
  Sandbox,
  type CommandResult,
} from "e2b";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import type {
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  ExecCommandOptions,
  ProviderSandboxListing,
  RefreshUrlsResult,
  SandboxExecResult,
  SandboxService,
  StreamCommandHandlers,
} from "../../provider";
import type { SandboxAdapter } from "../../shared/adapter";
import type { E2bConfig } from "../config";
import { E2bAdapter } from "./adapter";
import { connectE2bSandbox, e2bApiOptions } from "./client";

export const E2B_URL_TTL_S = 24 * 60 * 60;
export const E2B_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const E2B_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

/** Translate Amika's idle-stop minutes into E2B's bounded timeout. */
export function e2bTimeoutMs(autoStopInterval?: number | null): number {
  if (autoStopInterval == null) return E2B_DEFAULT_TIMEOUT_MS;
  if (autoStopInterval <= 0) return E2B_MAX_TIMEOUT_MS;
  return Math.min(autoStopInterval * 60_000, E2B_MAX_TIMEOUT_MS);
}

export async function createE2bSandbox(
  ctx: SandboxCtx,
  config: E2bConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  if (!input.snapshot) {
    throw new Error(
      "E2B requires a prepared template (set the matching E2B_TEMPLATE_* variable)",
    );
  }
  ctx.logger.info(
    { name: input.name, snapshot: input.snapshot },
    "Creating E2B sandbox",
  );
  const metadata = {
    ...input.labels,
    "amika-sandbox-name": input.name,
  };
  const sandbox = await Sandbox.create(input.snapshot, {
    ...e2bApiOptions(config),
    metadata,
    timeoutMs: e2bTimeoutMs(input.autoStopInterval),
    lifecycle: { onTimeout: "pause", autoResume: false },
    network: { allowPublicTraffic: true },
  });
  return {
    provider: "e2b",
    providerSandboxId: sandbox.sandboxId,
    providerUrl: null,
    services: input.services,
    envVars: {},
  };
}

export async function startE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  await connectE2bSandbox(
    config,
    providerSandboxId,
    e2bTimeoutMs(autoStopInterval),
  );
}

export async function stopE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<void> {
  await Sandbox.pause(providerSandboxId, {
    ...e2bApiOptions(config),
    keepMemory: true,
  });
}

export async function deleteE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<void> {
  await Sandbox.kill(providerSandboxId, e2bApiOptions(config));
}

export async function getE2bSandboxState(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<string> {
  return (await Sandbox.getInfo(providerSandboxId, e2bApiOptions(config)))
    .state;
}

export function mapE2bSandboxState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "suspended";
    default:
      return "unknown";
  }
}

export async function refreshE2bUrls(
  config: E2bConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  const refreshed = services.map((service) => ({
    ...service,
    url: `https://${sandbox.getHost(service.containerPort)}`,
  }));
  return {
    providerUrl:
      refreshed.find((service) => service.name === "Coding Agent")?.url ?? null,
    services: refreshed,
  };
}

export function syncE2bRoutes(): Promise<void> {
  return Promise.resolve();
}

export async function executeE2bCommand(
  config: E2bConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  if (opts?.input !== undefined) {
    const handle = await sandbox.commands.run(command, {
      ...commandOptions(opts),
      background: true,
      stdin: true,
    });
    await handle.sendStdin(opts.input);
    await handle.closeStdin();
    try {
      return await handle.wait();
    } catch (error) {
      if (error instanceof CommandExitError) return commandExitResult(error);
      throw error;
    }
  }
  try {
    return await sandbox.commands.run(command, commandOptions(opts));
  } catch (error) {
    if (error instanceof CommandExitError) return commandExitResult(error);
    throw error;
  }
}

export async function streamE2bCommand(
  config: E2bConfig,
  providerSandboxId: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  await sandbox.commands.run(command, {
    timeoutMs: 0,
    onStdout: handlers.onStdout,
    onStderr: handlers.onStderr,
  });
}

export async function readE2bFile(
  config: E2bConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  try {
    return await sandbox.files.read(filePath);
  } catch (error) {
    if (error instanceof FileNotFoundError) return null;
    throw error;
  }
}

export async function writeE2bFile(
  config: E2bConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  const data =
    typeof content === "string" ? content : Uint8Array.from(content).buffer;
  await sandbox.files.write(filePath, data);
}

export async function listE2bSandboxes(
  config: E2bConfig,
): Promise<ProviderSandboxListing[]> {
  const apiOptions = e2bApiOptions(config);
  const paginator = Sandbox.list(apiOptions);
  const listings: ProviderSandboxListing[] = [];
  while (paginator.hasNext) {
    const page = await paginator.nextItems();
    for (const info of page) {
      const metrics = await Sandbox.getMetrics(info.sandboxId, apiOptions);
      const latest = metrics.at(-1);
      if (!latest || latest.diskTotal <= 0) continue;
      listings.push({
        providerSandboxId: info.sandboxId,
        orgId: info.metadata[SANDBOX_ORG_ID_LABEL] ?? null,
        state: info.state,
        sizing: {
          vcpus: info.cpuCount,
          memoryGib: info.memoryMB / 1024,
          diskGib: latest.diskTotal / 1024 ** 3,
        },
      });
    }
  }
  return listings;
}

export async function openE2bAdapter(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  return new E2bAdapter(await connectE2bSandbox(config, providerSandboxId));
}

function commandOptions(opts?: ExecCommandOptions) {
  return {
    cwd: opts?.cwd,
    envs: opts?.env,
    user: opts?.sudo ? ("root" as const) : undefined,
    timeoutMs: 0,
  };
}

function commandExitResult(error: CommandExitError): CommandResult {
  return {
    exitCode: error.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
    ...(error.error ? { error: error.error } : {}),
  };
}
