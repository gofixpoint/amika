/**
 * Sandbox-level operations against the Vercel Sandbox API: create (from a
 * prepared VCR image or captured snapshot), start/stop/delete, preview-URL
 * resolution, exec, log
 * streaming, and file reads, plus the cold-resume service restart. The
 * provisioning lifecycle lives in `@amika/sandbox-provisioning`; this module
 * keeps the generic provider mechanics, including {@link openVercelAdapter} and
 * {@link writeVercelResumeContext} (the provisioning seam the package drives).
 * Vercel has no native clone primitive, so the provisioning layer clones over
 * the adapter's exec port rather than through this module.
 */
import { Sandbox } from "@vercel/sandbox";
import { shellQuote } from "../../../util/shell";
import { AMIKAD_ETC_DIR, SANDBOX_ORG_ID_LABEL } from "../../../constants";
import { withStepContext } from "../../../util/errorutils";
import type { SandboxCtx } from "../../../logger";
import type { VercelConfig } from "../config";
import {
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type ProviderSandboxListing,
  type RefreshUrlsResult,
  type SandboxExecResult,
  type SandboxService,
  type StreamCommandHandlers,
} from "../../provider";
import type { SandboxStatus } from "../../../sandbox-status";
import { execChecked, type SandboxAdapter } from "../../shared/adapter";
import { execWithStagedInput } from "../../shared/exec-input";
import { buildLifecycleCommands } from "../../shared/lifecycle-commands";
import { buildVercelCommand, VercelAdapter } from "./adapter";
import { getVercelSandbox, vercelCredentials } from "./client";
import { vercelSizingForVcpus, vercelVcpusForSize } from "../sizing";

/**
 * Vercel preview URLs are backed by per-port subdomains that are stable for the
 * sandbox's lifetime (`sandbox.domain(port)`), so — like Freestyle's domain
 * mappings, and unlike Daytona's signed URLs — they don't expire. Use a long
 * TTL so a sandbox's `urls_expire_at` stays far in the future and the refresh
 * path rarely churns.
 */
export const VERCEL_URL_TTL_S = 365 * 24 * 60 * 60;

/**
 * Default session timeout for a sandbox. Vercel's own default is 5 minutes,
 * which is far too short for an interactive agent session, so a freshly created
 * sandbox is given this window. Vercel sandboxes are persistent (auto-snapshot
 * on stop, resume on the next call), so the timeout behaves like an idle-suspend
 * interval rather than a hard delete — work can always resume afterwards.
 */
const VERCEL_DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Ceiling applied to a user-requested auto-stop interval. Per-plan session
 * limits cap how long a single session may run; clamping here keeps `create`
 * from being rejected for an over-limit timeout. A longer-lived sandbox simply
 * suspends at the ceiling and resumes on the next use (persistence).
 */
const VERCEL_MAX_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Vercel caps the number of ports a sandbox may expose. The platform limit is
 * 15 across all plans (Hobby/Pro/Enterprise; see Vercel's Sandbox pricing &
 * limits docs) — the `@vercel/sandbox` type comment that says "up to 4" is
 * stale. We cap the service port list here (the Coding Agent port is always
 * kept first) rather than letting `create` reject an over-limit request.
 */
export const VERCEL_MAX_EXPOSED_PORTS = 15;

/**
 * Translate the persisted `auto_stop_interval` (minutes) into Vercel's session
 * `timeout` (ms): `>0` → that many minutes (clamped to the plan ceiling); `0`
 * ("never") and absent both fall back to the default window, since Vercel has
 * no unbounded session — persistence (resume-on-next-use) provides the
 * "effectively never stops" behavior instead.
 */
export function vercelTimeoutMs(autoStopInterval?: number | null): number {
  if (autoStopInterval != null && autoStopInterval > 0) {
    return Math.min(autoStopInterval * 60_000, VERCEL_MAX_TIMEOUT_MS);
  }
  return VERCEL_DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the prepared source a new sandbox boots from. Default sandboxes use a
 * VCR image that has the amikad lifecycle hook bundle
 * (`/usr/lib/amikad/*`) and agent tooling (OpenCode, the agent CLIs) baked in —
 * the same prepared-image dependency Daytona and Freestyle have. A plain Vercel
 * runtime (`node24`, `python3.13`, …) has none of that, so the Vercel
 * provisioning flow would fail at the very first lifecycle step
 * (`run-hook.sh … pre-setup.sh`) before the user's setup script could run.
 *
 * Captured user snapshots remain bootable through their `snap_...` ids. Rather
 * than silently booting a runtime that cannot initialize, require one of those
 * two prepared sources and fail loudly at create when it is missing.
 */
export function resolveVercelBootSource(
  snapshot: string | undefined,
): { source: { type: "snapshot"; snapshotId: string } } | { image: string } {
  if (snapshot?.startsWith("snap_")) {
    return { source: { type: "snapshot", snapshotId: snapshot } };
  }
  if (snapshot?.startsWith("vcr.vercel.com/")) {
    return { image: snapshot };
  }
  throw new Error(
    "Vercel sandboxes require a prepared VCR image or captured snapshot with " +
      "the amikad hook bundle and agent tooling baked in, but none is " +
      "configured for this preset/size " +
      `(got ${snapshot ? `"${snapshot}"` : "no snapshot"}). Set the ` +
      "Vercel image configuration to a vcr.vercel.com/… reference; a plain " +
      "Vercel runtime cannot boot an Amika sandbox.",
  );
}

/**
 * The (deduped, capped) set of container ports to expose for a sandbox's
 * services. The Coding Agent port is kept first so it is never the one dropped
 * when more than {@link VERCEL_MAX_EXPOSED_PORTS} services are requested.
 */
export function resolveVercelPorts(services: SandboxService[]): number[] {
  const ordered = [
    ...services.filter((s) => s.name === "Coding Agent"),
    ...services.filter((s) => s.name !== "Coding Agent"),
  ];
  const unique: number[] = [];
  for (const service of ordered) {
    if (!unique.includes(service.containerPort)) {
      unique.push(service.containerPort);
    }
  }
  return unique.slice(0, VERCEL_MAX_EXPOSED_PORTS);
}

/** Up to 5 key-value tags (the Vercel limit) to stamp on the sandbox. */
function vercelTags(
  labels?: Record<string, string>,
): Record<string, string> | undefined {
  if (!labels) return undefined;
  const entries = Object.entries(labels).slice(0, 5);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export async function createVercelSandbox(
  ctx: SandboxCtx,
  config: VercelConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const services = input.services;
  const ports = resolveVercelPorts(services);
  const bootSource = resolveVercelBootSource(input.snapshot);
  const timeoutMs = vercelTimeoutMs(input.autoStopInterval);
  // Map the requested size to Vercel's `resources` (vCPU count, memory derived
  // at 2 GB/vCPU). Daytona/Freestyle bake size into the image/snapshot; Vercel
  // takes it at create time, so without this every size would boot at Vercel's
  // default 2 vCPUs. Omitted when no size is requested (keeps Vercel's default).
  const resources = input.size
    ? { vcpus: vercelVcpusForSize(input.size) }
    : undefined;

  ctx.logger.info(
    { bootSource, ports, timeoutMs, resources },
    "Creating Vercel sandbox",
  );

  // Org/user attribution rides on tags (the Vercel analogue of Daytona's
  // labels); the name is left for Vercel to generate, since the generated name
  // is the stable handle we reconnect by. The repo is cloned inside the sandbox
  // during initialization (like Freestyle), not via Vercel's git `source`, so
  // create only needs the prepared source, ports, timeout, resources, and tags.
  const sandbox = await withStepContext("vercel create: create sandbox", () =>
    Sandbox.create({
      ...vercelCredentials(config),
      ports,
      timeout: timeoutMs,
      persistent: true as const,
      // Persistence auto-snapshots the filesystem on every stop / idle-timeout.
      // Keep only the latest snapshot so storage stays flat across resume cycles
      // (older auto-snapshots are evicted), and disable expiration (`0`) so a
      // dormant sandbox never loses its resumable state to Vercel's default
      // 30-day snapshot expiry — Amika owns the sandbox lifetime via
      // `auto_delete_interval` / an explicit delete, which drops the snapshot too.
      keepLastSnapshots: { count: 1 },
      snapshotExpiration: 0,
      tags: vercelTags(input.labels),
      ...(resources ? { resources } : {}),
      ...bootSource,
    }),
  );

  return {
    provider: "vercel",
    providerSandboxId: sandbox.name,
    providerUrl: null,
    services,
    envVars: {},
  };
}

/**
 * Resolve each service's public preview URL from its exposed port. Vercel routes
 * are fixed at create (plus later `syncVercelRoutes` reconciles), so this is a
 * pure lookup (no mapping to create, unlike Freestyle). A port with no route
 * (one dropped by the {@link VERCEL_MAX_EXPOSED_PORTS} cap, or an authored
 * `sandbox_services` port that was added after create and so never exposed)
 * keeps an empty URL rather than throwing, so a single such service can't fail
 * the whole refresh (which the lifecycle re-run does not catch). Gate on the
 * sandbox's ACTUAL `routes`, not the desired service set, so an unexposed port
 * is skipped.
 */
export async function refreshVercelUrls(
  config: VercelConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: false,
  });
  const routedPorts = new Set(sandbox.routes.map((r) => r.port));
  const refreshed: SandboxService[] = [];
  let providerUrl: string | null = null;

  for (const service of services) {
    let url = "";
    if (routedPorts.has(service.containerPort)) {
      url = sandbox.domain(service.containerPort);
    }
    // TODO(KAPRO-616): an authored service port added after create is never
    // exposed on Vercel (routes are fixed at create), so it stays url-less
    // here. Expose it via `sandbox.update({ ports })` before minting instead of
    // skipping it.
    refreshed.push({ ...service, url });
    if (service.name === "Coding Agent" && url) {
      providerUrl = url;
    }
  }

  return { providerUrl, services: refreshed };
}

/**
 * The exposed-port list that realizes `desired`, or `null` when the live set
 * already matches. Pure so it is unit-testable: service ports (deduped,
 * "Coding Agent" prioritized, capped at {@link VERCEL_MAX_EXPOSED_PORTS}).
 * Order-insensitive comparison, since `update({ ports })` needs a change only
 * when the *set* differs.
 *
 * A live route the desired set no longer contains is dropped. New sandboxes
 * never expose the legacy `websocat` SSH bridge port (2222), since the code
 * that added it on demand is gone, but an older sandbox may still carry it;
 * reconciling here tears it down, since it is no longer part of any desired
 * service set.
 */
export function portsForDesiredServices(
  currentPorts: number[],
  desired: SandboxService[],
): number[] | null {
  const ports = resolveVercelPorts(desired);
  const current = new Set(currentPorts);
  if (ports.length === current.size && ports.every((p) => current.has(p))) {
    return null;
  }
  return ports;
}

/**
 * Reconcile the sandbox's exposed ports to exactly the desired service set.
 * Vercel routes are fixed at create, so this both tears down a deleted
 * service's route (its subdomain would otherwise
 * keep routing until the sandbox dies) and finally exposes a service port
 * added after create (TODO(KAPRO-616): `refreshVercelUrls` skipped those). A
 * legacy `websocat` SSH bridge route (port 2222) lingering on an older sandbox
 * is torn down here too, since it is no longer part of any desired service set.
 */
export async function syncVercelRoutes(
  config: VercelConfig,
  providerSandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: false,
  });
  const nextPorts = portsForDesiredServices(
    sandbox.routes.map((r) => r.port),
    desired,
  );
  if (nextPorts === null) return;
  // TODO(KAPRO-616, remaining half): this read-modify-write of the full
  // `ports` list is not serialized per sandbox. Two concurrent syncs each start
  // from an earlier `sandbox.routes` snapshot, so the last `update({ ports })`
  // can resurrect another deleted service's route or drop a just-added one. The
  // declarative shape narrows the window to a single write but does not
  // serialize it; coordinate per-sandbox (or re-read and reconcile on conflict)
  // before relying on this for real Vercel usage.
  await sandbox.update({ ports: nextPorts });
}

export async function getVercelSandboxState(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<string> {
  try {
    const sandbox = await getVercelSandbox(config, providerSandboxId, {
      resume: false,
    });
    return sandbox.status;
  } catch {
    // A missing/deleted sandbox can't be fetched; report it as absent rather
    // than throwing, mirroring Freestyle's `unknown` for a VM not in the list.
    return "unknown";
  }
}

/**
 * Enumerate every sandbox in the Vercel account with its org stamp (a tag),
 * status, and provisioned sizing. `Sandbox.list().toArray()` auto-paginates and
 * flattens to the individual sandboxes. Vercel exposes only the vCPU count on a
 * listed sandbox; memory and disk are recovered from its fixed 2 GB-per-vCPU /
 * 32 GB-disk coupling (see {@link vercelSizingForVcpus}). Sandboxes with no
 * reported vCPU count are excluded — they can't be sized or priced.
 */
export async function listVercelSandboxes(
  config: VercelConfig,
): Promise<ProviderSandboxListing[]> {
  const list = await Sandbox.list(vercelCredentials(config));
  const sandboxes = await list.toArray();
  const listings: ProviderSandboxListing[] = [];
  for (const sandbox of sandboxes) {
    if (sandbox.vcpus == null) continue;
    const sizing = vercelSizingForVcpus(sandbox.vcpus);
    listings.push({
      providerSandboxId: sandbox.name,
      orgId: sandbox.tags?.[SANDBOX_ORG_ID_LABEL] ?? null,
      state: sandbox.status,
      sizing: {
        vcpus: sizing.vcpus,
        memoryGib: sizing.memoryGb,
        diskGib: sizing.diskGb,
      },
    });
  }
  return listings;
}

/**
 * Map a raw Vercel sandbox status into the canonical lifecycle vocabulary.
 * Raw values are the `@vercel/sandbox` status union plus the synthesized
 * `"unknown"` for a missing/deleted sandbox. `stopped` reads as `suspended`
 * (persistent sandboxes resume from their last snapshot); `aborted` is
 * terminal like `failed`.
 */
export function mapVercelSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "snapshotting":
      return "snapshotting";
    case "stopping":
      return "stopping";
    case "stopped":
      return "suspended";
    case "failed":
    case "aborted":
      return "failed";
    default:
      return "unknown";
  }
}

export async function startVercelSandbox(
  config: VercelConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  // `Sandbox.get({ resume: true })` resumes a stopped (persistent) sandbox from
  // its last snapshot, but the resume completes on the first real call; run a
  // no-op so the VM is live before the lifecycle restart proceeds.
  await sandbox.runCommand({ cmd: "true" });
  // Re-apply the persisted auto-stop choice as the session timeout (Vercel does
  // not carry a per-sandbox idle policy across sessions), mirroring how
  // Freestyle re-applies its idle timeout on every start.
  await sandbox.update({ timeout: vercelTimeoutMs(autoStopInterval) });
}

export async function stopVercelSandbox(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: false,
  });
  // Persistent sandboxes snapshot their filesystem on stop and resume from it on
  // the next `start`. `stop()` is safe to call on an already-stopped sandbox.
  await sandbox.stop();
}

export async function deleteVercelSandbox(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: false,
  });
  await sandbox.delete();
}

/**
 * Root-only file (0600, written via sudo) holding just enough to relaunch a
 * sandbox's services after a cold resume without any external lookup: the
 * OpenCode server password, the OpenCode-web mode, and the repo working dir.
 * Kept out of `/etc/environment` (which every shell auto-sources, and which a
 * cloned repo's setup script could read) so the password isn't exposed to user
 * code — the rest of the start-phase env is already persisted there and gets
 * sourced by `buildVercelCommand` on the restart execs.
 */
export const VERCEL_RESUME_CONTEXT_PATH = `${AMIKAD_ETC_DIR}/vercel-resume.json`;

interface VercelResumeContext {
  openCodePassword: string;
  amikaOpenCodeWeb?: string | null;
  /** Repo working directory (`AMIKA_AGENT_CWD`); the lifecycle hooks' cwd. */
  repoDir: string;
}

/**
 * Persist the {@link VercelResumeContext} so {@link restartVercelServicesOnResume}
 * can restart services after an idle-timeout resume. Written during create and
 * restart, when the password and repo dir are known.
 */
export async function writeVercelResumeContext(
  adapter: SandboxAdapter,
  context: VercelResumeContext,
): Promise<void> {
  const tempPath = `/tmp/amika-vercel-resume-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`;
  await adapter.uploadFile(JSON.stringify(context) + "\n", tempPath);
  await execChecked(adapter, `mkdir -p ${shellQuote(AMIKAD_ETC_DIR)}`, {
    sudo: true,
  });
  await execChecked(
    adapter,
    `install -m 0600 ${shellQuote(tempPath)} ${shellQuote(VERCEL_RESUME_CONTEXT_PATH)}`,
    { sudo: true },
  );
  await execChecked(adapter, `rm -f ${shellQuote(tempPath)}`, { sudo: true });
}

/** Read back the persisted resume context, or null when it isn't present yet. */
async function readVercelResumeContext(
  adapter: SandboxAdapter,
): Promise<VercelResumeContext | null> {
  const result = await adapter.exec(
    `cat ${shellQuote(VERCEL_RESUME_CONTEXT_PATH)}`,
    { sudo: true },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as VercelResumeContext;
  } catch {
    return null;
  }
}

/**
 * SDK `onResume` callback for the exec/stream paths: when Vercel wakes a stopped
 * session it restores the filesystem but not the processes the lifecycle hooks
 * started, leaving OpenCode and the user services dead. Re-run the start-phase
 * hooks (pre-setup → post-setup → start) to bring them back, mirroring how
 * `runLifecycleScripts({ phase: "start" })` restarts them on an explicit start.
 * The base/service/injected env is sourced from `/etc/environment` (persisted by
 * `configureManagedEnvironment`); the password/web/cwd come from the persisted
 * resume context. Best-effort: a sandbox resumed mid-initialization has no
 * context yet (skip), and a restart failure is swallowed rather than failing the
 * triggering exec — the next interaction retries and direct execs (e.g. agent
 * launches) don't need OpenCode to be up.
 */
async function restartVercelServicesOnResume(sandbox: Sandbox): Promise<void> {
  try {
    const adapter = new VercelAdapter(sandbox);
    const context = await readVercelResumeContext(adapter);
    if (!context) {
      return;
    }
    // TODO(KAPRO-840): the Pi web terminal is not relaunched here. `pre-setup.sh`
    // gates it on `AMIKA_PI_WEB` / `AMIKA_PI_WEB_PASSWORD`, which the resume
    // context does not carry, so a resumed sandbox keeps its Pi service URL
    // while nothing listens on port 60997 until an explicit restart. Known
    // limitation: this path is Vercel-only and that provider is not in use.
    const hookEnv: Record<string, string> = {
      AMIKA_AGENT_CWD: context.repoDir,
      OPENCODE_SERVER_PASSWORD: context.openCodePassword,
    };
    if (context.amikaOpenCodeWeb != null) {
      hookEnv.AMIKA_OPENCODE_WEB = context.amikaOpenCodeWeb;
    }
    const commands = buildLifecycleCommands();
    await execChecked(adapter, commands.preSetup, {
      cwd: context.repoDir,
      env: hookEnv,
      sudo: true,
    });
    await execChecked(adapter, commands.postSetup, {
      cwd: context.repoDir,
      sudo: true,
    });
    await execChecked(adapter, commands.start, {
      cwd: context.repoDir,
      env: hookEnv,
    });
  } catch {
    // Swallow — see the doc comment: this is a best-effort recovery, and the
    // direct-exec paths that trigger it don't depend on the restarted services.
  }
}

export async function readVercelFile(
  config: VercelConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  const adapter = new VercelAdapter(sandbox);
  return adapter.downloadFile(filePath);
}

export async function writeVercelFile(
  config: VercelConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  await new VercelAdapter(sandbox).uploadFile(content, filePath);
}

export async function executeVercelCommand(
  config: VercelConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
    // Default relaunches the lifecycle services on a cold resume so an
    // interactive session is fully live; `"bare"` skips that (e.g. the chat
    // worker's agent launch / exit probe, which don't need OpenCode up).
    onResume:
      opts?.resumeMode === "bare" ? undefined : restartVercelServicesOnResume,
  });
  // A resumed sandbox reverts to Vercel's short default timeout; reapply the
  // caller's window before running so a long command isn't suspended mid-run.
  if (opts?.sessionTimeoutMs != null) {
    await sandbox.update({ timeout: opts.sessionTimeoutMs });
  }
  const adapter = new VercelAdapter(sandbox);
  if (opts?.input !== undefined) {
    return execWithStagedInput(adapter, command, opts.input, opts);
  }
  return adapter.exec(command, opts);
}

/**
 * Run `command` and stream its output through `handlers`. Vercel exposes
 * incremental logs via the `command.logs()` async generator, so — unlike
 * Freestyle, whose `vm.exec` buffers until exit — Vercel can back the SSE
 * agent-stream endpoint. The command is run detached and we resolve once it
 * finishes.
 */
export async function streamVercelCommandLogs(
  config: VercelConfig,
  providerSandboxId: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
    onResume: restartVercelServicesOnResume,
  });
  const cmd = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", buildVercelCommand(command)],
    detached: true,
  });
  for await (const log of cmd.logs()) {
    if (log.stream === "stdout") {
      handlers.onStdout(log.data);
    } else {
      handlers.onStderr?.(log.data);
    }
  }
  await cmd.wait();
}

/**
 * Open a Vercel adapter handle (the core provisioning seam). Resumes the
 * sandbox (`resume: true`) exactly as the provisioning flows do, since
 * provisioning always operates on a live sandbox; the fetched handle is reused
 * across the package's many adapter ops rather than re-resumed per op.
 */
export async function openVercelAdapter(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  return new VercelAdapter(sandbox);
}
