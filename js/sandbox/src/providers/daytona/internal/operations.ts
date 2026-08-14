/**
 * Sandbox-level operations against the Daytona API: create, start/stop/delete,
 * SSH access, URL refresh, and file reads. The provisioning lifecycle lives in
 * `@amika/sandbox-provisioning`; this module keeps only the generic provider
 * mechanics, including {@link openDaytonaAdapter}, the provisioning seam the
 * package drives.
 */
import { Daytona, DaytonaError } from "@daytonaio/sdk";
import pRetry from "p-retry";
import {
  SANDBOX_DELETE_INTERVAL_KEEP_ON_STOP,
  SANDBOX_ENV_SECRETS_EXCLUDED_LABEL,
  SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
  SANDBOX_ORG_ID_LABEL,
} from "../../../constants";
import { DEFAULT_HOME_DIR } from "../../../constants";
import type { DaytonaConfig } from "../config";
import type { SandboxCtx } from "../../../logger";
import { createDaytonaClient } from "./client";
import { createVmSandbox } from "./vm";
import { ensureDaytonaSnapshotActive } from "./snapshot-operations";
import { DaytonaAdapter } from "./adapter";
import {
  SIGNED_URL_EXPIRY_S,
  type DaytonaCreateRequest,
  type SandboxService,
} from "./types";
import {
  type CloneRepoInput,
  type ExecCommandOptions,
  type ProviderSandboxListing,
  type SandboxExecResult,
  type StreamCommandHandlers,
} from "../../provider";
import { executeCommand } from "./commands";
import { cloneRepository } from "./configure";
import type { SandboxStatus } from "../../../sandbox-status";
import type { SandboxAdapter } from "../../shared/adapter";
import { getRepoDir } from "../../shared/adapter-helpers";

export async function refreshDaytonaUrls(
  config: DaytonaConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<{ providerUrl: string | null; services: SandboxService[] }> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  return refreshServiceUrls(sandbox, services);
}

/**
 * Refresh signed preview URLs for all services using an already-fetched
 * sandbox object.
 */
async function refreshServiceUrls(
  sandbox: Awaited<ReturnType<Daytona["get"]>>,
  services: SandboxService[],
): Promise<{ providerUrl: string | null; services: SandboxService[] }> {
  const refreshed: SandboxService[] = [];
  let providerUrl: string | null = null;

  for (const service of services) {
    const preview = await sandbox.getSignedPreviewUrl(
      service.containerPort,
      SIGNED_URL_EXPIRY_S,
    );
    refreshed.push({ ...service, url: preview.url });
    if (service.name === "Coding Agent") {
      providerUrl = preview.url;
    }
  }

  return { providerUrl, services: refreshed };
}

export async function getDaytonaSandboxState(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<string> {
  const daytona = createDaytonaClient(config);
  try {
    const sandbox = await daytona.get(providerSandboxId);
    return sandbox.state ?? "unknown";
  } catch {
    // A missing/deleted sandbox makes `daytona.get` reject; report it as
    // absent rather than throwing, mirroring Vercel/Freestyle's `unknown`
    // so a deleted VM never reads back as a healthy running sandbox.
    return "unknown";
  }
}

/**
 * Map a raw Daytona `SandboxState` into the canonical lifecycle vocabulary.
 * Raw values are the `@daytonaio/sdk` `SandboxState` enum. Judgment calls:
 * `forking` keeps the source running, so it reads as `running`; `archiving`/
 * `archived` happen to an already-stopped sandbox, so both read as
 * `suspended`; `resizing` is a transition back toward up, so `starting`.
 */
export function mapDaytonaSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "creating":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
      return "creating";
    case "restoring":
    case "starting":
    case "resuming":
    case "resizing":
      return "starting";
    case "started":
    case "forking":
      return "running";
    case "snapshotting":
      return "snapshotting";
    case "stopping":
    case "pausing":
      return "stopping";
    case "stopped":
    case "paused":
    case "archiving":
    case "archived":
      return "suspended";
    case "error":
    case "build_failed":
    case "destroying":
    case "destroyed":
      return "failed";
    default:
      return "unknown";
  }
}

/** Per-page fetch size for the `daytona.list()` cursor iterator (not a cap on
 * the total returned). */
const DAYTONA_LIST_PAGE_SIZE = 100;

/**
 * Enumerate every sandbox in the Daytona account with its org stamp, raw state,
 * and provisioned sizing. `daytona.list()` is a cursor-paginated async iterator
 * (Daytona retired the offset `page`/`limit` flow), so iterating it transparently
 * walks every page; `limit` is only the per-page fetch size, not a cap on the
 * total. Errored/deleted sandboxes are excluded by the API default. Daytona
 * reports sizing already in billing units (`cpu`/`memory`/`disk` =
 * vCPUs/GiB/GiB), so no MiB→GiB conversion is needed. `createDaytonaClient`
 * scopes to the configured organization, so the listing is account-wide within
 * it.
 */
export async function listDaytonaSandboxes(
  config: DaytonaConfig,
): Promise<ProviderSandboxListing[]> {
  const daytona = createDaytonaClient(config);
  const listings: ProviderSandboxListing[] = [];
  for await (const sandbox of daytona.list({ limit: DAYTONA_LIST_PAGE_SIZE })) {
    listings.push({
      providerSandboxId: sandbox.id,
      orgId: sandbox.labels?.[SANDBOX_ORG_ID_LABEL] ?? null,
      state: sandbox.state ?? "unknown",
      sizing: {
        vcpus: sandbox.cpu,
        memoryGib: sandbox.memory,
        diskGib: sandbox.disk,
      },
    });
  }
  return listings;
}

export async function startDaytonaSandbox(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  await sandbox.start();
}

export async function stopDaytonaSandbox(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  await sandbox.stop();
}

export async function deleteDaytonaSandbox(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);

  await pRetry(() => sandbox.delete(), {
    retries: 3,
    minTimeout: 3_000,
    factor: 1,
    shouldRetry: ({ error }) =>
      error instanceof DaytonaError &&
      error.statusCode === 400 &&
      error.message.toLowerCase().includes("state change in progress"),
  });
}

/**
 * Mints short-lived SSH access to a Daytona sandbox.
 *
 * `sandbox.createSshAccess()` returns a shape like:
 *
 * ```jsonc
 * {
 *   "id": "13f7d7e1-...",
 *   "sandboxId": "8c416541-...",
 *   "token": "<token>",
 *   "expiresAt": "2026-06-05T05:38:11.846Z",
 *   "createdAt": "2026-06-04T21:38:11.845Z",
 *   "updatedAt": "2026-06-04T21:38:11.845Z",
 *   "sshCommand": "ssh <token>@ssh.app.daytona.io"
 * }
 * ```
 *
 * The rotating `token` is the SSH **user** (`ssh <token>@ssh.app.daytona.io`);
 * the host is the fixed `ssh.app.daytona.io` gateway with no explicit port. We
 * expose `sshDestination` (the command with the leading `ssh ` stripped, i.e.
 * `<token>@ssh.app.daytona.io`) so callers consume the parsed destination rather
 * than re-parsing the command. Because the credential lives in the username, a
 * new connection mints a brand-new destination each time.
 */
export async function createDaytonaSshAccess(
  config: DaytonaConfig,
  providerSandboxId: string,
  expiresInMinutes: number = 60,
): Promise<{
  token: string;
  sshCommand: string;
  sshDestination: string;
  expiresAt: Date;
}> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  const sshAccess = await sandbox.createSshAccess(expiresInMinutes);
  return {
    token: sshAccess.token,
    sshCommand: sshAccess.sshCommand,
    expiresAt: sshAccess.expiresAt,
    sshDestination: _parseSshDestination(sshAccess.sshCommand),
  };
}

/**
 * Derives the SSH destination (`[user@]host`) from a Daytona `sshCommand` by
 * stripping the leading `ssh ` prefix. Exported for testing. This is the single
 * place that knows Daytona's `ssh <destination>` command shape; callers consume
 * the parsed `sshDestination` rather than re-parsing the command.
 */
export function _parseSshDestination(sshCommand: string): string {
  return sshCommand.replace(/^ssh\s+/, "").trim();
}

export async function revokeDaytonaSshAccess(
  config: DaytonaConfig,
  providerSandboxId: string,
  token: string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  await sandbox.revokeSshAccess(token);
}

/**
 * Timeout for sandbox creation, in seconds. The SDK default is 60s, which
 * a sandbox created from a captured snapshot cannot meet when the target
 * runner has to cold-pull the multi-GB snapshot image — observed pulls
 * run minutes. Preset creates are unaffected: creation resolves as soon
 * as the sandbox reaches `started`. Applies to both paths: the container
 * path passes it to `daytona.create` (which waits for `started`), and the
 * VM path uses it as the budget for `createVmSandbox`'s started-wait.
 */
const SANDBOX_CREATE_TIMEOUT_S = 5 * 60;

export async function createDaytonaSandbox(
  ctx: SandboxCtx,
  config: DaytonaConfig,
  input: DaytonaCreateRequest,
): Promise<{
  provider: string;
  providerSandboxId: string;
  providerUrl: string | null;
  services: SandboxService[];
  envVars: Record<string, string>;
}> {
  const daytona = createDaytonaClient(config);
  const cwd = getRepoDir(DEFAULT_HOME_DIR, input.repoName);

  // Only NON-SECRET operational vars go into the container env. Anything
  // passed to `daytona.create({ envVars })` becomes part of the container's
  // spec, which `_experimental_createSnapshot` bakes into the snapshot image
  // — and no Daytona API can scrub a sandbox's env afterward. So secrets
  // (OPENCODE_SERVER_PASSWORD + injected user env) are deliberately NOT set
  // here; they are delivered via /etc/environment (configureSshEnvironment)
  // and passed explicitly to the lifecycle scripts (runLifecycleScripts),
  // both of which the snapshot scrubber can clean.
  //
  // AMIKA_AGENT_CWD and AMIKA_SANDBOX_NAME are also seeded into the base block
  // of /etc/environment during initialize, but that file is only sourced by
  // login shells — the launched agent runs via a non-login `process.exec`
  // (see DaytonaAdapter.exec), which inherits the container env, not the
  // managed file. Baking them here is what actually makes them visible to the
  // agent. They are per-sandbox, so a from-snapshot boot re-sets them via this
  // create call (create-time env overrides the value baked into the snapshot
  // image); both are non-secret, so baking them carries no scrub concern.
  const envVars: Record<string, string> = {
    AMIKA_AGENT_CWD: cwd,
    AMIKA_SANDBOX_NAME: input.name,
  };
  if (input.amikaOpenCodeWeb != null) {
    envVars.AMIKA_OPENCODE_WEB = input.amikaOpenCodeWeb;
  }

  // Mark the sandbox as having secrets kept out of its container env, so
  // "snapshot and delete" can tell it apart from sandboxes whose baked-in
  // env secrets a snapshot can't scrub. Only stamp it when the base
  // snapshot is itself clean (`scrubSafe`): a sandbox booted from a dirty
  // snapshot inherits that snapshot's baked container ENV, so it is NOT
  // scrub-safe even though this create call injects no new secrets.
  const labels = input.scrubSafe
    ? {
        ...input.labels,
        [SANDBOX_ENV_SECRETS_EXCLUDED_LABEL]:
          SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
      }
    : input.labels;
  const autoStopInterval = input.autoStopInterval ?? 30;
  const autoDeleteInterval =
    input.autoDeleteInterval ?? SANDBOX_DELETE_INTERVAL_KEEP_ON_STOP;

  // A base snapshot Daytona has flipped to `inactive` (it does so after ~2
  // weeks without use) makes the create below fail with "Snapshot <name> is
  // inactive" instead of reactivating it. Reactivate first so the boot
  // succeeds; no-op for the common already-active case.
  if (await ensureDaytonaSnapshotActive(config, input.snapshot)) {
    ctx.logger.info(
      { snapshot: input.snapshot },
      "Reactivated inactive Daytona snapshot before create",
    );
  }

  ctx.logger.info(
    {
      name: input.name,
      snapshot: input.snapshot,
      envVarKeys: Object.keys(envVars),
      useVm: config.useVm ?? false,
    },
    "Creating Daytona sandbox",
  );

  // VM mode boots the sandbox as a `linux-vm` instead of a container. The SDK's
  // `create()` can't set the sandbox class, so go through the api-client; the
  // resulting sandbox (and any snapshot later captured from it) is a VM. The
  // container path keeps using the SDK unchanged.
  const providerSandboxId = config.useVm
    ? await createVmSandbox(config, {
        name: input.name,
        snapshot: input.snapshot,
        env: envVars,
        labels,
        autoStopInterval,
        autoDeleteInterval,
        timeoutSeconds: SANDBOX_CREATE_TIMEOUT_S,
      })
    : (
        await daytona.create(
          {
            name: input.name,
            snapshot: input.snapshot,
            envVars,
            labels,
            public: false,
            autoStopInterval,
            autoDeleteInterval,
          },
          { timeout: SANDBOX_CREATE_TIMEOUT_S },
        )
      ).id;

  return {
    provider: "daytona",
    providerSandboxId,
    providerUrl: null,
    services: input.services,
    envVars,
  };
}

export async function readSandboxFile(
  config: DaytonaConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const daytona = createDaytonaClient(config);
    const sandbox = await daytona.get(providerSandboxId);
    const content = await sandbox.fs.downloadFile(filePath);
    return content.toString("utf8");
  } catch {
    return null;
  }
}

export async function writeSandboxFile(
  config: DaytonaConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  await new DaytonaAdapter(sandbox, daytona).uploadFile(content, filePath);
}

/**
 * Open a Daytona adapter handle (the provisioning seam). Fetches the sandbox
 * once and wraps it, so a caller can reuse the handle across its many adapter
 * ops rather than re-fetching per op.
 */
export async function openDaytonaAdapter(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  const daytona = createDaytonaClient(config);
  return new DaytonaAdapter(await daytona.get(providerSandboxId), daytona);
}

/** Run a one-shot command in the sandbox (fetch the handle, then exec). */
export async function executeDaytonaCommand(
  config: DaytonaConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  return executeCommand(sandbox, command, opts);
}

/**
 * Stream a command's output over a Daytona process session. The
 * WebSocket-based callback overload resolves when the command finishes and the
 * socket closes; the session is best-effort deleted afterwards.
 */
export async function streamDaytonaCommandLogs(
  config: DaytonaConfig,
  providerSandboxId: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  const sessionId = `agent-stream-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  try {
    const execResult = await sandbox.process.executeSessionCommand(sessionId, {
      command,
      runAsync: true,
    });
    const commandId = execResult.cmdId!;
    await sandbox.process.getSessionCommandLogs(
      sessionId,
      commandId,
      (chunk: string) => handlers.onStdout(chunk),
      (chunk: string) => handlers.onStderr?.(chunk),
    );
  } finally {
    sandbox.process.deleteSession(sessionId).catch(() => {});
  }
}

/** Clone one repo into a Daytona sandbox via the SDK's native `git.clone`. */
export async function cloneDaytonaRepo(
  config: DaytonaConfig,
  providerSandboxId: string,
  input: CloneRepoInput,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  await cloneRepository(
    sandbox,
    input.homeDir,
    input.githubUrl,
    input.repoName,
    input.githubToken,
    input.branch,
  );
}
