/**
 * Sandbox operations against the Runtime API: create, delete, start, stop,
 * state, and listing (https://withruntime.com/docs/reference/sandboxes.md).
 *
 * - **Run state.** Runtime has no stopped state: `stop` pauses the sandbox
 *   (`:pause`) and `start` resumes it (`:resume`). A paused sandbox is
 *   kept until deleted. Runtime also pauses a sandbox after an idle period
 *   (`idlePauseSeconds`, from `autoStopInterval`), and a command, file
 *   call, or preview visit wakes it.
 * - **Size.** Free-form: any vCPU count, memory, and disk up to the plan's
 *   limits. Runtime refuses more with `limit_exceeded`.
 * - **Name.** Runtime names must be unique in the project and have
 *   undocumented rules, so create sends none. The exact Amika name rides in
 *   a label.
 * - **User.** Runtime logs in as `runtime`. Create makes the `amika` rig
 *   user (`../../shared/rig-user.ts`) before it returns.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import { withStepContext } from "../../../util/errorutils";
import type {
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  ProviderSandboxListing,
} from "../../provider";
import { rigUserOps } from "../../shared/rig-user";
import type { RuntimeConfig } from "../config";
import {
  isNotFound,
  requestJson,
  RuntimeApiError,
  sandboxPath,
  sandboxSchema,
  send,
  type RuntimeSandbox,
} from "./client";
import { runtimeShell } from "./shell";

/** The boot source that means Runtime's default image (Ubuntu 24.04). */
export const RUNTIME_DEFAULT_IMAGE = "runtime";

export const RUNTIME_NAME_LABEL = "amika-sandbox-name";
const CREATE_ID_LABEL = "amika-create-id";
const MANAGED_LABEL = "amika-managed";

/** Runtime's idle-pause bounds, in seconds (0 turns it off). */
const MIN_IDLE_PAUSE_S = 60;
const MAX_IDLE_PAUSE_S = 86_400;

/** The longest one long-poll (`?wait=`) holds, in seconds. */
const LONG_POLL_S = 60;

/** How long a create, resume, or pause may take to settle. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Map Amika's idle-stop interval (minutes) to `idlePauseSeconds`.
 * `undefined`: keep Runtime's default (300 seconds). Exported for tests.
 */
export function idlePauseSeconds(
  autoStopInterval?: number | null,
): number | undefined {
  if (autoStopInterval == null) return undefined;
  if (autoStopInterval <= 0) return 0;
  return Math.min(
    Math.max(Math.round(autoStopInterval * 60), MIN_IDLE_PAUSE_S),
    MAX_IDLE_PAUSE_S,
  );
}

/**
 * Create a sandbox, wait until it runs, and make the `amika` user. A
 * sandbox that fails on the way is deleted.
 */
export async function createRuntimeSandbox(
  ctx: SandboxCtx,
  config: RuntimeConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const createId = randomUUID();
  const idlePause = idlePauseSeconds(input.autoStopInterval);
  const body: Record<string, unknown> = {
    labels: {
      ...input.labels,
      [RUNTIME_NAME_LABEL]: input.name,
      [CREATE_ID_LABEL]: createId,
      [MANAGED_LABEL]: "true",
    },
    user: "runtime",
    ...(input.snapshot && input.snapshot !== RUNTIME_DEFAULT_IMAGE
      ? { image: input.snapshot }
      : {}),
    ...(input.resources
      ? {
          vcpu: input.resources.vcpus,
          memoryGB: input.resources.memoryGib,
          diskGB: input.resources.diskGib,
        }
      : {}),
    ...(idlePause !== undefined ? { idlePauseSeconds: idlePause } : {}),
  };
  ctx.logger.info(
    { name: input.name, snapshot: input.snapshot, resources: input.resources },
    "Creating Runtime sandbox",
  );

  const deleteFailed = (id: string) =>
    deleteRuntimeSandbox(config, id).catch((cleanup: unknown) =>
      ctx.logger.warn(
        { err: cleanup, sandboxId: id },
        "Could not delete a failed Runtime sandbox",
      ),
    );

  let sandbox: RuntimeSandbox;
  try {
    sandbox = await requestJson(config, sandboxSchema, "POST", "/sandboxes", {
      json: body,
      // Create returns once the sandbox runs.
      timeoutMs: SETTLE_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof RuntimeApiError && error.status < 500)) {
      // We do not know if Runtime made the sandbox. The caller gets no id,
      // so find it by its create id and delete it.
      await listManaged(config, `${CREATE_ID_LABEL}:${createId}`)
        .then((found) => Promise.all(found.map((s) => deleteFailed(s.id))))
        .catch((cleanup: unknown) =>
          ctx.logger.warn(
            { err: cleanup },
            "Could not look for a sandbox after a failed Runtime create",
          ),
        );
    }
    throw error;
  }
  const id = sandbox.id;
  try {
    if (sandbox.state !== "running") {
      await withStepContext("runtime create: wait until running", () =>
        waitWhile(config, id, "starting", "running"),
      );
    }
    await withStepContext("runtime create: rig user", () =>
      rigUserOps(runtimeShell(config, id)).ensureRigUser(),
    );
  } catch (error) {
    await deleteFailed(id);
    throw error;
  }
  return {
    provider: "runtime",
    providerSandboxId: id,
    services: input.services,
    // No env at create: provisioning writes the variables to
    // `/etc/environment`.
    envVars: {},
  };
}

/** Get a sandbox; `null` when it does not exist. */
export async function getRuntimeSandbox(
  config: RuntimeConfig,
  sandboxId: string,
  query?: Record<string, string>,
): Promise<RuntimeSandbox | null> {
  try {
    return await requestJson(
      config,
      sandboxSchema,
      "GET",
      sandboxPath(sandboxId),
      { query, timeoutMs: (LONG_POLL_S + 15) * 1000 },
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Long-poll while the sandbox is in `transient`, then require `wanted`.
 * `GET ?wait=&ifState=` holds the request until the state changes.
 */
async function waitWhile(
  config: RuntimeConfig,
  sandboxId: string,
  transient: string,
  wanted: string,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const sandbox = await getRuntimeSandbox(config, sandboxId, {
      wait: String(LONG_POLL_S),
      ifState: transient,
    });
    if (!sandbox) throw new Error(`Runtime sandbox ${sandboxId} is gone`);
    if (sandbox.state === wanted) return;
    if (sandbox.state !== transient) {
      throw new Error(
        `Runtime sandbox ${sandboxId} is ${sandbox.state}, not ${wanted}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Runtime sandbox ${sandboxId} was still ${transient} after ` +
          `${SETTLE_TIMEOUT_MS / 1000}s`,
      );
    }
  }
}

/** Delete a sandbox. A missing sandbox is a no-op. */
export async function deleteRuntimeSandbox(
  config: RuntimeConfig,
  sandboxId: string,
): Promise<void> {
  try {
    const res = await send(config, "DELETE", sandboxPath(sandboxId));
    await res.body?.cancel();
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Resume a paused sandbox, wait until it runs, and set its idle pause. */
export async function startRuntimeSandbox(
  config: RuntimeConfig,
  sandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const sandbox = await getRuntimeSandbox(config, sandboxId);
  if (!sandbox) throw new Error(`Runtime sandbox ${sandboxId} does not exist`);
  if (sandbox.state === "paused") {
    const res = await send(config, "POST", sandboxPath(sandboxId, ":resume"));
    await res.body?.cancel();
  }
  if (sandbox.state !== "running") {
    await waitWhile(config, sandboxId, "starting", "running");
  }
  const idlePause = idlePauseSeconds(autoStopInterval);
  if (idlePause !== undefined) {
    const res = await send(config, "POST", sandboxPath(sandboxId, ":update"), {
      json: { idlePauseSeconds: idlePause },
    });
    await res.body?.cancel();
  }
  await rigUserOps(runtimeShell(config, sandboxId)).ensureRigUser();
}

/** Pause a sandbox and wait until it is paused. */
export async function stopRuntimeSandbox(
  config: RuntimeConfig,
  sandboxId: string,
): Promise<void> {
  const sandbox = await getRuntimeSandbox(config, sandboxId);
  if (!sandbox) throw new Error(`Runtime sandbox ${sandboxId} does not exist`);
  if (sandbox.state === "paused") return;
  const paused = await requestJson(
    config,
    sandboxSchema,
    "POST",
    sandboxPath(sandboxId, ":pause"),
  );
  if (paused.state !== "paused") {
    await waitWhile(config, sandboxId, paused.state, "paused");
  }
}

export async function getRuntimeSandboxState(
  config: RuntimeConfig,
  sandboxId: string,
): Promise<string> {
  return (await getRuntimeSandbox(config, sandboxId))?.state ?? "unknown";
}

/** Map a Runtime sandbox state to the canonical status. */
export function mapRuntimeSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "paused":
      // `stop` pauses, and so does the idle timer: both read as stopped,
      // as E2B's pause does.
      return "stopped";
    case "error":
      return "failed";
    default:
      // `deleted`, and states we do not know.
      return "unknown";
  }
}

const sandboxListSchema = z.object({
  items: z.array(sandboxSchema),
  next: z.string().nullish(),
});

const MAX_LIST_PAGES = 1000;

/** Every sandbox Amika created, optionally narrowed by one more label. */
async function listManaged(
  config: RuntimeConfig,
  extraLabel?: string,
): Promise<RuntimeSandbox[]> {
  const all: RuntimeSandbox[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: "200" });
    query.append("label", `${MANAGED_LABEL}:true`);
    if (extraLabel) query.append("label", extraLabel);
    if (cursor) query.set("cursor", cursor);
    const res = await requestJson(
      config,
      sandboxListSchema,
      "GET",
      `/sandboxes?${query.toString()}`,
    );
    all.push(...res.items);
    if (!res.next) return all;
    cursor = res.next;
  }
  throw new Error(`Runtime listing did not end within ${MAX_LIST_PAGES} pages`);
}

/** Every sandbox Amika created, with its Amika name, org, and size. */
export async function listRuntimeSandboxes(
  config: RuntimeConfig,
): Promise<ProviderSandboxListing[]> {
  const listings: ProviderSandboxListing[] = [];
  for (const sandbox of await listManaged(config)) {
    // Without a size the sandbox cannot be priced; skip it.
    if (sandbox.vcpu == null || sandbox.memoryGB == null) continue;
    listings.push({
      providerSandboxId: sandbox.id,
      name: sandbox.labels?.[RUNTIME_NAME_LABEL] ?? sandbox.name ?? null,
      orgId: sandbox.labels?.[SANDBOX_ORG_ID_LABEL] ?? null,
      state: sandbox.state,
      sizing: {
        vcpus: sandbox.vcpu,
        memoryGib: sandbox.memoryGB,
        diskGib: sandbox.diskGB ?? 0,
      },
    });
  }
  return listings;
}
