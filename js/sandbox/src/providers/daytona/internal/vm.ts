/**
 * VM-mode Daytona operations, gated by `ENABLE_DAYTONA_VM`
 * (`DaytonaConfig.useVm`).
 *
 * A Daytona "VM" is a sandbox whose class is `linux-vm` rather than the default
 * `container`. The high-level `@daytonaio/sdk` wrapper hard-codes its request
 * bodies and exposes neither the sandbox `class` (settable only at create time)
 * nor `includeMemory` (required to snapshot a *running* VM), so these paths call
 * the generated `@daytona/api-client` `SandboxApi` directly. The container paths
 * still go through the SDK; the snapshot path here runs only for sandboxes that
 * are actually `linux-vm` (see `isVmSandbox`), not merely because `useVm` is set.
 */
import pRetry from "p-retry";
import {
  SandboxApi,
  Configuration,
  SandboxClass,
  SandboxState,
  type CreateSandbox,
} from "@daytona/api-client";
import type { DaytonaConfig } from "../config";

/** Poll cadence while waiting for a VM sandbox to reach a target state. */
const VM_POLL_INTERVAL_MS = 1_000;

/**
 * Per-request timeout for a single state poll. Without it a hung `getSandbox`
 * would block the wait loop forever, so the deadline check below never runs
 * and, on the create path, the VM is never cleaned up. Bounded well above a
 * healthy poll's latency so only a genuinely stuck request trips it.
 */
const VM_POLL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a VM to reach a power state (stop/start) during capture,
 * in seconds. Generous — a cold boot re-runs the VM's init — but bounded so a
 * wedged transition surfaces instead of hanging.
 */
const VM_STATE_TRANSITION_TIMEOUT_S = 5 * 60;

const sandboxApis = new WeakMap<DaytonaConfig, SandboxApi>();

/**
 * The low-level generated `SandboxApi` for `config`, mirroring the SDK's auth:
 * the Daytona API key as a Bearer token in the default request headers. The
 * region/target is sent per-request in the create body (not on the client), and
 * the snapshot-capture endpoint operates on an existing sandbox by id, so a
 * single client serves both VM calls.
 *
 * Memoized per config, like the SDK client in `./client`.
 */
function getSandboxApi(config: DaytonaConfig): SandboxApi {
  const cached = sandboxApis.get(config);
  if (cached) {
    return cached;
  }
  const api = new SandboxApi(
    new Configuration({
      basePath: config.apiUrl,
      baseOptions: { headers: { Authorization: `Bearer ${config.apiKey}` } },
    }),
  );
  sandboxApis.set(config, api);
  return api;
}

export interface CreateVmSandboxParams {
  name: string;
  snapshot: string;
  /** Non-secret container env; mirrors the SDK `create({ envVars })` mapping. */
  env: Record<string, string>;
  labels: Record<string, string> | undefined;
  autoStopInterval: number;
  autoDeleteInterval: number;
  timeoutSeconds: number;
}

/**
 * Create a sandbox as a Daytona VM (`class: "linux-vm"`). Sends the same fields
 * the SDK's `daytona.create({ snapshot })` would, plus the `class` field the SDK
 * omits — `class` is not on the typed `CreateSandbox` body, so it is attached
 * explicitly (the api-client serializes the whole object, so it reaches the
 * server). Returns the new sandbox id.
 *
 * Waits for the VM to reach `STARTED` before returning, matching the contract
 * the container path gets for free: `daytona.create()` blocks until the sandbox
 * is started. The generated `createSandbox` does NOT — it resolves as soon as
 * the row is created, while the VM is still creating/pulling/booting. Without
 * this wait the caller proceeds to initialize immediately, and the first
 * adapter call (an `exec`) hits a not-yet-running VM and fails with
 * "sandbox is in stopped state" (503, `x-daytona-sandbox-state: stopped`). That
 * race is usually won on a warm snapshot (boots in seconds) but lost once
 * Daytona has archived the snapshot: restoring the multi-GB image runs minutes,
 * so the same `params.timeoutSeconds` budget the create request uses is applied
 * to the started-wait too.
 */
export async function createVmSandbox(
  config: DaytonaConfig,
  params: CreateVmSandboxParams,
): Promise<string> {
  const body: CreateSandbox & { class: SandboxClass } = {
    name: params.name,
    snapshot: params.snapshot,
    env: params.env,
    labels: params.labels,
    public: false,
    target: config.target,
    autoStopInterval: params.autoStopInterval,
    autoDeleteInterval: params.autoDeleteInterval,
    class: SandboxClass.LINUX_VM,
  };
  const api = getSandboxApi(config);
  const response = await api.createSandbox(body, undefined, {
    timeout: params.timeoutSeconds * 1000,
  });
  const providerSandboxId = response.data.id;
  try {
    await waitForVmSandboxState(
      api,
      providerSandboxId,
      "create",
      params.timeoutSeconds,
      (sandbox) => sandbox.state === SandboxState.STARTED,
    );
  } catch (waitErr) {
    // The VM exists but never reached STARTED (timeout or terminal state).
    // The caller's create-error path can't clean it up because we never
    // returned the id, and the default autoDeleteInterval is -1 (never), so
    // the VM would be orphaned. Delete it here. A wait timeout often means
    // Daytona is mid-transition (e.g. still pulling/restoring a large
    // snapshot), so the delete can hit `400 state change in progress` just
    // like `deleteDaytonaSandbox`; retry that case rather than leak the VM.
    // Best-effort: swallow any final cleanup failure so the original wait
    // error is what surfaces.
    try {
      await pRetry(
        () =>
          api.deleteSandbox(providerSandboxId, undefined, {
            timeout: VM_STATE_TRANSITION_TIMEOUT_S * 1000,
          }),
        {
          retries: 3,
          minTimeout: 3_000,
          factor: 1,
          shouldRetry: ({ error }) => isStateChangeInProgressError(error),
        },
      );
    } catch {
      // Ignore; rethrow the original wait failure below.
    }
    throw waitErr;
  }
  return providerSandboxId;
}

/**
 * Whether `error` is Daytona's retryable `400 state change in progress`. The
 * raw api-client surfaces axios errors rather than the SDK's `DaytonaError`
 * (which `deleteDaytonaSandbox` matches on `instanceof`), so this inspects the
 * axios response shape, falling back to the error's own status/message.
 */
function isStateChangeInProgressError(error: unknown): boolean {
  const e = error as {
    response?: { status?: number; data?: unknown };
    status?: number;
    message?: string;
  };
  const status = e?.response?.status ?? e?.status;
  if (status !== 400) {
    return false;
  }
  // Match against the error message plus the response body in whatever shape
  // Daytona sends it: a plain string, or a structured object under any key
  // (`{ message }`, `{ error }`, `{ code }`, ...). Stringifying the object
  // rather than reading a fixed key keeps this robust to the exact envelope.
  const data = e?.response?.data;
  const body =
    typeof data === "string" ? data : data != null ? JSON.stringify(data) : "";
  const text = `${e?.message ?? ""} ${body}`.toLowerCase();
  return text.includes("state change in progress");
}

/**
 * Whether `providerSandboxId` is a Daytona VM (`class: linux-vm`) rather than
 * the default container.
 *
 * The snapshot path must branch on the sandbox's real class, not on `useVm`: a
 * sandbox created before the flag was enabled — or booted from a container base
 * image — is still a container, and Daytona rejects VM-only snapshot behavior
 * on it ("includeMemory is only supported for VM sandboxes").
 */
export async function isVmSandbox(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<boolean> {
  const { data: sandbox } =
    await getSandboxApi(config).getSandbox(providerSandboxId);
  return sandbox.sandboxClass === SandboxClass.LINUX_VM;
}

/** Throw if `sandbox` is in a terminal failure state during `phase`. */
function assertNotTerminalState(
  sandbox: { state?: SandboxState; errorReason?: string },
  providerSandboxId: string,
  phase: string,
): void {
  // ARCHIVED/DESTROYED are included so an auto-archive or teardown of the
  // stopped VM mid-capture fails fast instead of spinning to the deadline.
  if (
    sandbox.state === SandboxState.ERROR ||
    sandbox.state === SandboxState.BUILD_FAILED ||
    sandbox.state === SandboxState.ARCHIVED ||
    sandbox.state === SandboxState.DESTROYED
  ) {
    throw new Error(
      `VM sandbox "${providerSandboxId}" entered terminal state "${sandbox.state}" during ${phase}` +
        (sandbox.errorReason ? `: ${sandbox.errorReason}` : ""),
    );
  }
}

/**
 * Poll `getSandbox` until `isDone` returns true, throwing if the sandbox
 * reaches a terminal failure state or the deadline passes. `isDone` receives
 * each polled sandbox (so a caller can track transitions across polls).
 */
async function waitForVmSandboxState(
  api: SandboxApi,
  providerSandboxId: string,
  phase: string,
  timeoutSeconds: number,
  isDone: (sandbox: { state?: SandboxState }) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const { data: sandbox } = await api.getSandbox(
      providerSandboxId,
      undefined,
      undefined,
      { timeout: VM_POLL_REQUEST_TIMEOUT_MS },
    );
    assertNotTerminalState(sandbox, providerSandboxId, phase);
    if (isDone(sandbox)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `VM sandbox "${providerSandboxId}" did not reach the expected state during ${phase} within ${timeoutSeconds}s (last state: "${sandbox.state}")`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, VM_POLL_INTERVAL_MS));
  }
}

/**
 * Capture a *cold* snapshot from a VM sandbox: stop it, snapshot the stopped
 * VM (live memory excluded), then restart it if the caller keeps the source.
 *
 * Why cold rather than hot: a snapshot taken with `includeMemory: true` bakes
 * the running VM's RAM into the image, so a sandbox booted from it RESUMES that
 * memory — including the source VM's frozen network stack and its old address.
 * Restored into a new VM with a different network identity, egress is dead: any
 * `git clone`/fetch fails with "connection reset by peer" (and it's systemic —
 * every outbound connection, not repo- or token-specific). Stopping the VM
 * first makes the restore a clean cold boot with fresh networking, exactly like
 * a first-time sandbox. Stopping the whole VM also quiesces the inner Docker
 * daemon, so the container-path `stopDockerForSnapshot` dance isn't needed here.
 * Dropping `includeMemory` additionally means the snapshot can't carry live RAM
 * (or secrets a process had read into it) — the concern the hot path documented.
 *
 * `restartAfterCapture` distinguishes the callers: the non-destructive "full"
 * capture keeps the source, so it must be running again afterward (true); the
 * scrub-and-delete caller deletes the source, so it skips the restart (false) —
 * a stopped VM deletes fine, and a kept source on the failure path is released
 * to its real (stopped) power state out of band.
 *
 * Throws if the sandbox reaches a terminal failure state or a phase exceeds its
 * timeout. Snapshot *durability* is gated downstream by
 * `waitForDaytonaSnapshotActive`; this only waits for the sandbox to finish its
 * snapshotting phase.
 *
 * NOTE: confirm against live Daytona that a memory-excluded snapshot of a
 * stopped `linux-vm` (a) captures cleanly and (b) surfaces SNAPSHOTTING before
 * `createSandboxSnapshot` returns — the snapshot-phase wait assumes it, as the
 * SDK does. No local harness exercises the real provider.
 */
export async function captureVmSandboxSnapshot(
  config: DaytonaConfig,
  providerSandboxId: string,
  snapshotName: string,
  timeoutSeconds: number,
  restartAfterCapture: boolean,
): Promise<void> {
  const api = getSandboxApi(config);

  // The stop + snapshot are inside the try so the `finally`'s keep-path restart
  // runs on EVERY failure after we begin stopping — otherwise a failed stop or
  // stop-wait would leave a full-capture source powered off while its recorded
  // state still reads `active`. Restarting a VM that never actually stopped is an
  // idempotent no-op.
  try {
    // Stop the VM (graceful) so the snapshot is taken cold.
    await api.stopSandbox(providerSandboxId, undefined, undefined, {
      timeout: VM_STATE_TRANSITION_TIMEOUT_S * 1000,
    });
    await waitForVmSandboxState(
      api,
      providerSandboxId,
      "stop",
      VM_STATE_TRANSITION_TIMEOUT_S,
      (sandbox) => sandbox.state === SandboxState.STOPPED,
    );

    await api.createSandboxSnapshot(
      providerSandboxId,
      // Memory excluded: the VM is stopped, so this is a cold snapshot.
      { name: snapshotName },
      undefined,
      { timeout: timeoutSeconds * 1000 },
    );
    // Wait out the snapshotting phase. Daytona moves the sandbox into
    // SNAPSHOTTING before this poll's first read (the create call returns after
    // the transition is applied), so waiting until it is no longer SNAPSHOTTING
    // is sufficient — the same shape the SDK's own `waitForSnapshotComplete`
    // uses. Snapshot *durability* is gated downstream by
    // `waitForDaytonaSnapshotActive`.
    await waitForVmSandboxState(
      api,
      providerSandboxId,
      "snapshot",
      timeoutSeconds,
      (sandbox) => sandbox.state !== SandboxState.SNAPSHOTTING,
    );
  } finally {
    if (restartAfterCapture) {
      await api.startSandbox(providerSandboxId, undefined, {
        timeout: VM_STATE_TRANSITION_TIMEOUT_S * 1000,
      });
      await waitForVmSandboxState(
        api,
        providerSandboxId,
        "restart",
        VM_STATE_TRANSITION_TIMEOUT_S,
        (sandbox) => sandbox.state === SandboxState.STARTED,
      );
    }
  }
}
