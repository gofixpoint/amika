import {
  App,
  FileNotFoundError,
  NotFoundError,
  Sailbox,
  type Listener,
} from "@sailresearch/sdk";
import { DEFAULT_HOME_DIR, SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import { shellQuote } from "../../../util/shell";
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
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";
import type { SailboxConfig } from "../config";
import { decodeSailboxImageRef } from "../image-ref";
import { sailboxSizingForSize } from "../sizing";
import { createSailClient, getSailbox, sailboxApiUrl } from "./client";

export const SAILBOX_URL_TTL_S = 365 * 24 * 60 * 60;

export async function createSailboxSandbox(
  ctx: SandboxCtx,
  config: SailboxConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  if (input.snapshot.trim() === "") {
    throw new Error(
      "Sailbox sandboxes require a published SAILBOX_IMAGE_* value or a captured checkpoint id",
    );
  }
  const client = createSailClient(config);
  const image = decodeSailboxImageRef(input.snapshot);
  const ports = uniqueServicePorts(input.services);
  const sizing = sailboxSizingForSize(input.size ?? "m");
  const orgId = input.labels?.[SANDBOX_ORG_ID_LABEL];
  if (!orgId) {
    throw new Error(
      `Sailbox create requires the ${SANDBOX_ORG_ID_LABEL} label`,
    );
  }

  ctx.logger.info(
    { image: image !== null, ports, sizing },
    "Creating Sailbox sandbox",
  );

  let box: Sailbox;
  if (image) {
    const app = await App.find(sailboxAppName(config, orgId), {
      client,
      mintIfMissing: true,
    });
    box = await Sailbox.create({
      client,
      app,
      name: input.name,
      image,
      ingressPorts: ports,
      size: sizing.size,
      memoryGib: sizing.memoryGib,
      diskGib: sizing.diskGib,
    });
  } else {
    box = await Sailbox.fromCheckpoint({
      client,
      checkpointId: input.snapshot,
      name: input.name,
    });
    await Promise.all(ports.map((port) => box.expose(port)));
  }

  await configureSailboxAutoSleep(
    config,
    box.sailboxId,
    input.autoStopInterval,
  );
  return {
    provider: "sailbox",
    providerSandboxId: box.sailboxId,
    providerUrl: null,
    services: input.services,
    envVars: {},
  };
}

export async function deleteSailboxSandbox(
  config: SailboxConfig,
  providerSandboxId: string,
): Promise<void> {
  await (await getSailbox(config, providerSandboxId)).terminate();
}

export async function startSailboxSandbox(
  config: SailboxConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const box = await getSailbox(config, providerSandboxId);
  if (box.status !== "running") await box.resume();
  await configureSailboxAutoSleep(config, providerSandboxId, autoStopInterval);
}

export async function stopSailboxSandbox(
  config: SailboxConfig,
  providerSandboxId: string,
): Promise<void> {
  const box = await getSailbox(config, providerSandboxId);
  if (box.status !== "paused") await box.pause();
}

export async function getSailboxSandboxState(
  config: SailboxConfig,
  providerSandboxId: string,
): Promise<string> {
  try {
    return (await getSailbox(config, providerSandboxId)).status;
  } catch (error) {
    if (error instanceof NotFoundError) return "unknown";
    throw error;
  }
}

export function mapSailboxSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "creating":
      return "creating";
    case "running":
      return "running";
    case "paused":
    case "sleeping":
    case "interrupted_restorable":
      return "suspended";
    case "terminating":
      return "stopping";
    case "terminated":
    case "failed":
    case "create_failed":
    case "interrupted_unsafe_to_retry":
      return "failed";
    default:
      return "unknown";
  }
}

export async function executeSailboxCommand(
  config: SailboxConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  return new SailboxAdapter(await getSailbox(config, providerSandboxId)).exec(
    command,
    opts,
  );
}

export async function streamSailboxCommandLogs(
  config: SailboxConfig,
  providerSandboxId: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const box = await getSailbox(config, providerSandboxId);
  const process = await box.exec(asAmikaCommand(command), {
    cwd: DEFAULT_HOME_DIR,
  });
  await Promise.all([
    consume(process.stdout, handlers.onStdout),
    consume(process.stderr, (chunk) => handlers.onStderr?.(chunk)),
    process.wait(),
  ]);
}

export async function readSailboxFile(
  config: SailboxConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  return new SailboxAdapter(
    await getSailbox(config, providerSandboxId),
  ).downloadFile(filePath);
}

export async function writeSailboxFile(
  config: SailboxConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  await new SailboxAdapter(
    await getSailbox(config, providerSandboxId),
  ).uploadFile(content, filePath);
}

export async function openSailboxAdapter(
  config: SailboxConfig,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  return new SailboxAdapter(await getSailbox(config, providerSandboxId));
}

export async function refreshSailboxUrls(
  config: SailboxConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const box = await getSailbox(config, providerSandboxId);
  const existing = new Map(
    (await box.listeners()).map((listener) => [listener.guestPort, listener]),
  );
  let providerUrl: string | null = null;
  const refreshed: SandboxService[] = [];
  for (const service of services) {
    const listener =
      existing.get(service.containerPort) ??
      (await box.expose(service.containerPort));
    const url = httpListenerUrl(listener);
    refreshed.push({ ...service, url });
    if (service.name === "Coding Agent") providerUrl = url;
  }
  return { providerUrl, services: refreshed };
}

export async function syncSailboxRoutes(
  config: SailboxConfig,
  providerSandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  const box = await getSailbox(config, providerSandboxId);
  const desiredPorts = new Set(uniqueServicePorts(desired));
  const existing = await box.listeners();
  await Promise.all([
    ...existing
      .filter((listener) => !desiredPorts.has(listener.guestPort))
      .map((listener) => box.unexpose(listener.guestPort)),
    ...[...desiredPorts]
      .filter(
        (port) => !existing.some((listener) => listener.guestPort === port),
      )
      .map((port) => box.expose(port)),
  ]);
}

export async function listSailboxSandboxes(
  config: SailboxConfig,
): Promise<ProviderSandboxListing[]> {
  const boxes = await Sailbox.list({ client: createSailClient(config) });
  const listings: ProviderSandboxListing[] = [];
  for (const box of boxes) {
    if (
      box.vcpuCount == null ||
      box.memoryMib == null ||
      box.stateDiskSizeGib == null
    ) {
      continue;
    }
    listings.push({
      providerSandboxId: box.sailboxId,
      orgId: sailboxAppOrgId(config, box.appName),
      state: box.status,
      sizing: {
        vcpus: box.vcpuCount,
        memoryGib: box.memoryMib / 1024,
        diskGib: box.stateDiskSizeGib,
      },
    });
  }
  return listings;
}

export function sailboxAppName(config: SailboxConfig, orgId: string): string {
  return `${config.appPrefix ?? "amika"}-${orgId}`;
}

export function sailboxAppOrgId(
  config: SailboxConfig,
  appName: string | undefined,
): string | null {
  const prefix = `${config.appPrefix ?? "amika"}-`;
  return appName?.startsWith(prefix) ? appName.slice(prefix.length) : null;
}

export async function configureSailboxAutoSleep(
  config: SailboxConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  if (autoStopInterval == null) return;
  const base = sailboxApiUrl(config).replace(/\/$/, "");
  const response = await fetch(
    `${base}/sailboxes/${encodeURIComponent(providerSandboxId)}/auto_sleep`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        autoStopInterval === 0
          ? { automatic: false }
          : {
              automatic: true,
              min_seconds_before_sleep: autoStopInterval * 60,
            },
      ),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Sailbox auto-sleep update failed (${response.status} ${response.statusText})`,
    );
  }
}

class SailboxAdapter implements SandboxAdapter {
  constructor(private readonly box: Sailbox) {}

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const runCommand = opts?.sudo
      ? command
      : asAmikaCommand(command, opts?.env);
    const runOptions = {
      cwd: opts?.cwd ?? DEFAULT_HOME_DIR,
      ...(opts?.sudo && opts.env ? { env: opts.env } : {}),
    };
    if ("input" in (opts ?? {}) && (opts as ExecCommandOptions).input != null) {
      const process = await this.box.exec(runCommand, {
        ...runOptions,
        openStdin: true,
      });
      await process.writeStdin((opts as ExecCommandOptions).input!);
      await process.closeStdin();
      const [stdout, stderr, result] = await Promise.all([
        process.stdout.text(),
        process.stderr.text(),
        process.wait(),
      ]);
      return { exitCode: result.exitCode, stdout, stderr };
    }
    const result = await this.box.run(runCommand, runOptions);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async uploadFile(content: Buffer | string, path: string): Promise<void> {
    await this.box.fs.write(path, content);
    if (path === DEFAULT_HOME_DIR || path.startsWith(`${DEFAULT_HOME_DIR}/`)) {
      const result = await this.box.run(
        `chown amika:amika ${shellQuote(path)}`,
        { cwd: "/" },
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to set ownership on ${path}`);
      }
    }
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      return (await this.box.fs.read(path)).toString("utf8");
    } catch (error) {
      if (error instanceof FileNotFoundError) return null;
      throw error;
    }
  }
}

function uniqueServicePorts(services: SandboxService[]): number[] {
  return [...new Set(services.map((service) => service.containerPort))];
}

function httpListenerUrl(listener: Listener): string {
  if (listener.endpoint?.kind !== "http") {
    throw new Error(
      `Sailbox listener on port ${listener.guestPort} has no HTTP endpoint`,
    );
  }
  return listener.endpoint.url;
}

function asAmikaCommand(command: string, env?: Record<string, string>): string {
  const assignments = Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const envCommand = assignments ? `env ${assignments} ` : "";
  return `sudo -H -u amika -- ${envCommand}bash -lc ${shellQuote(command)}`;
}

async function consume(
  stream: AsyncIterable<string>,
  handler: (chunk: string) => void,
): Promise<void> {
  for await (const chunk of stream) handler(chunk);
}
