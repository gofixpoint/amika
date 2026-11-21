/**
 * Sandbox operations against the boat API: create, delete, start, stop,
 * state, listing, and the account's sizes.
 *
 * - **Async.** Create, resume, stop, and delete answer 202. We poll the
 *   sandbox (or the deletion operation) until it settles.
 * - **Size.** boat has four types (`small` 2/4, `default` 4/8, `large`
 *   8/16, `xlarge` 16/32 vCPU/GiB) and no other sizes.
 * - **Deadline.** boat stops a sandbox at a fixed deadline (`ttlSeconds`),
 *   which commands do not extend. A rig in use must not stop, so create and
 *   resume ask for none. A free trial refuses that; there we ask for the
 *   longest deadline it allows.
 * - **Secrets.** Create sets `noEnv`, so the sandbox gets none of the
 *   account's own secrets or CLI key.
 * - **User.** boat logs in as `user`. Create makes the `amika` rig user
 *   (`../../shared/rig-user.ts`) before it returns.
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
  SandboxResources,
} from "../../provider";
import { rigUserOps } from "../../shared/rig-user";
import type { BoatConfig } from "../config";
import {
  BoatApiError,
  isNotFound,
  requestJson,
  sandboxPath,
  sandboxSchema,
  send,
  type BoatSandbox,
} from "./client";
import { boatShell } from "./shell";

/** The boot source that means boat's own base image (Ubuntu 24.04). */
export const BOAT_BASE_IMAGE = "ubuntu-24.04";

/** The exact Amika name rides in this label. */
export const BOAT_NAME_LABEL = "amika-sandbox-name";
/** A random id for one create, to find a sandbox whose create answer was lost. */
const CREATE_ID_LABEL = "amika-create-id";
/** Marks the sandboxes Amika created; the listing filters on it. */
const MANAGED_LABEL = "amika-managed";

/** The longest deadline a free trial allows (`trial_auto_stop_required`). */
const TRIAL_TTL_SECONDS = 7200;

/** boat label values are at most 256 bytes. */
const MAX_LABEL_VALUE_BYTES = 256;

/** How long a create, resume, stop, or delete may take to settle. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2_000;

/** A boat machine type and its size. */
export interface BoatType {
  type: string;
  resources: SandboxResources;
}

/** boat's machine types, smallest first (https://docs.boat.dev/machines.md). */
export const BOAT_TYPES: readonly BoatType[] = [
  { type: "small", resources: { vcpus: 2, memoryGib: 4, diskGib: 51 } },
  { type: "default", resources: { vcpus: 4, memoryGib: 8, diskGib: 51 } },
  { type: "large", resources: { vcpus: 8, memoryGib: 16, diskGib: 111 } },
  { type: "xlarge", resources: { vcpus: 16, memoryGib: 32, diskGib: 251 } },
];

/** The machine type with exactly the requested vCPUs and memory. */
export function boatTypeFor(resources: SandboxResources): string {
  const match = BOAT_TYPES.find(
    (t) =>
      t.resources.vcpus === resources.vcpus &&
      t.resources.memoryGib === resources.memoryGib,
  );
  if (!match) {
    throw new Error(
      `boat has no machine type with ${resources.vcpus} vCPUs and ` +
        `${resources.memoryGib} GiB; it offers ${BOAT_TYPES.map(
          (t) => `${t.resources.vcpus}/${t.resources.memoryGib}`,
        ).join(", ")}`,
    );
  }
  return match.type;
}

/** States in which commands run. */
const READY_STATES = new Set(["ready", "idle", "running"]);
/** States a create or resume never leaves on its own. */
const FAILED_STATES = new Set(["error", "cancelled"]);

/** boat labels hold short values; drop any that would be refused. */
function boatLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).filter(
      ([key, value]) =>
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/.test(key) &&
        Buffer.byteLength(value) <= MAX_LABEL_VALUE_BYTES,
    ),
  );
}

/**
 * Create a sandbox, wait until it runs, and make the `amika` user. A
 * sandbox that fails on the way is deleted.
 */
export async function createBoatSandbox(
  ctx: SandboxCtx,
  config: BoatConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const createId = randomUUID();
  const body: Record<string, unknown> = {
    name: input.name.slice(0, 120),
    labels: boatLabels({
      ...input.labels,
      [BOAT_NAME_LABEL]: input.name,
      [CREATE_ID_LABEL]: createId,
      [MANAGED_LABEL]: "true",
    }),
    noEnv: true,
    ttlSeconds: null,
    ...(input.snapshot && input.snapshot !== BOAT_BASE_IMAGE
      ? { from: input.snapshot }
      : {}),
    ...(input.resources ? { type: boatTypeFor(input.resources) } : {}),
  };
  ctx.logger.info(
    { name: input.name, snapshot: input.snapshot, type: body.type },
    "Creating boat sandbox",
  );

  const deleteFailed = (id: string) =>
    deleteBoatSandbox(config, id).catch((cleanup: unknown) =>
      ctx.logger.warn(
        { err: cleanup, sandboxId: id },
        "Could not delete a failed boat sandbox",
      ),
    );

  let sandbox: BoatSandbox;
  try {
    sandbox = await postCreate(config, body);
  } catch (error) {
    if (!(error instanceof BoatApiError && error.status < 500)) {
      // We do not know if boat made the sandbox. The caller gets no id,
      // so find it by its create id and delete it.
      await listManagedSandboxes(config, `${CREATE_ID_LABEL}=${createId}`)
        .then((found) => Promise.all(found.map((s) => deleteFailed(s.id))))
        .catch((cleanup: unknown) =>
          ctx.logger.warn(
            { err: cleanup },
            "Could not look for a sandbox after a failed boat create",
          ),
        );
    }
    throw error;
  }
  const id = sandbox.id;
  try {
    await withStepContext("boat create: wait until ready", () =>
      waitForState(config, id, READY_STATES),
    );
    await withStepContext("boat create: rig user", () =>
      rigUserOps(boatShell(config, id)).ensureRigUser(),
    );
  } catch (error) {
    await deleteFailed(id);
    throw error;
  }
  return {
    provider: "boat",
    providerSandboxId: id,
    services: input.services,
    // `noEnv` keeps boat's env empty; provisioning writes the variables to
    // `/etc/environment`.
    envVars: {},
  };
}

const createResponseSchema = z.object({ sandbox: sandboxSchema });

/** Post a create; on a free trial, retry with the trial's longest deadline. */
async function postCreate(
  config: BoatConfig,
  body: Record<string, unknown>,
): Promise<BoatSandbox> {
  const post = (json: Record<string, unknown>) =>
    requestJson(config, createResponseSchema, "POST", "/sandboxes", {
      json,
      idempotent: true,
    });
  try {
    return (await post(body)).sandbox;
  } catch (error) {
    if (
      error instanceof BoatApiError &&
      error.code === "trial_auto_stop_required"
    ) {
      return (await post({ ...body, ttlSeconds: TRIAL_TTL_SECONDS })).sandbox;
    }
    throw error;
  }
}

const sandboxInfoSchema = z.object({ sandbox: sandboxSchema });

/** Get a sandbox; `null` when it does not exist. */
export async function getBoatSandbox(
  config: BoatConfig,
  sandboxId: string,
): Promise<BoatSandbox | null> {
  try {
    return (
      await requestJson(
        config,
        sandboxInfoSchema,
        "GET",
        sandboxPath(sandboxId),
      )
    ).sandbox;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Poll until the sandbox is in one of `wanted`. */
async function waitForState(
  config: BoatConfig,
  sandboxId: string,
  wanted: ReadonlySet<string>,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const sandbox = await getBoatSandbox(config, sandboxId);
    if (!sandbox) throw new Error(`boat sandbox ${sandboxId} is gone`);
    if (wanted.has(sandbox.state)) return;
    if (FAILED_STATES.has(sandbox.state)) {
      throw new Error(
        `boat sandbox ${sandboxId} is ${sandbox.state}` +
          (sandbox.error ? `: ${sandbox.error}` : ""),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `boat sandbox ${sandboxId} did not settle within ` +
          `${SETTLE_TIMEOUT_MS / 1000}s (last state: "${sandbox.state}")`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const deletionSchema = z.object({
  operation: z.object({ id: z.string(), status: z.string() }),
});
const deletionStatusSchema = z.object({
  operation: z.object({ status: z.string() }).optional(),
  status: z.string().optional(),
});

/** Delete a sandbox and wait until boat is done. A missing one is a no-op. */
export async function deleteBoatSandbox(
  config: BoatConfig,
  sandboxId: string,
): Promise<void> {
  let operationId: string;
  try {
    operationId = (
      await requestJson(
        config,
        deletionSchema,
        "DELETE",
        sandboxPath(sandboxId),
        // boat refuses a delete that does not name the sandbox again.
        { headers: { "X-Ascii-Confirm-Delete": sandboxId } },
      )
    ).operation.id;
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const res = await requestJson(
      config,
      deletionStatusSchema,
      "GET",
      `/deletion-operations/${encodeURIComponent(operationId)}`,
    );
    const status = res.operation?.status ?? res.status;
    if (status === "completed") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `boat did not finish deleting ${sandboxId} within ` +
          `${SETTLE_TIMEOUT_MS / 1000}s (last status: "${status}")`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Resume a stopped sandbox and wait until it runs. boat has no idle timer,
 * so `autoStopInterval` is not used; resume keeps the sandbox's deadline,
 * which create left unset.
 */
export async function startBoatSandbox(
  config: BoatConfig,
  sandboxId: string,
): Promise<void> {
  const sandbox = await getBoatSandbox(config, sandboxId);
  if (!sandbox) throw new Error(`boat sandbox ${sandboxId} does not exist`);
  if (!READY_STATES.has(sandbox.state)) {
    if (sandbox.state === "archiving") {
      await waitForState(config, sandboxId, new Set(["archived"]));
    }
    if (sandbox.state !== "provisioning" && sandbox.state !== "cloning") {
      const res = await send(
        config,
        "POST",
        sandboxPath(sandboxId, "/resume"),
        { json: {} },
      );
      await res.body?.cancel();
    }
    await waitForState(config, sandboxId, READY_STATES);
  }
  // A resume may land on a new machine; the disk keeps the user, but make
  // sure, since the command is cheap and changes nothing when it exists.
  await rigUserOps(boatShell(config, sandboxId)).ensureRigUser();
}

/** Stop a sandbox (boat saves its disk first) and wait until it is stopped. */
export async function stopBoatSandbox(
  config: BoatConfig,
  sandboxId: string,
): Promise<void> {
  const sandbox = await getBoatSandbox(config, sandboxId);
  if (!sandbox) throw new Error(`boat sandbox ${sandboxId} does not exist`);
  if (sandbox.state === "archived") return;
  const res = await send(config, "POST", sandboxPath(sandboxId, "/stop"), {
    json: {},
  });
  await res.body?.cancel();
  await waitForState(config, sandboxId, new Set(["archived"]));
}

/** The raw state, or `unknown` when the sandbox does not exist. */
export async function getBoatSandboxState(
  config: BoatConfig,
  sandboxId: string,
): Promise<string> {
  return (await getBoatSandbox(config, sandboxId))?.state ?? "unknown";
}

/** Map a boat sandbox state to the canonical status. */
export function mapBoatSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return "starting";
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archiving":
      return "stopping";
    case "archived":
      return "stopped";
    case "error":
    case "cancelled":
      return "failed";
    default:
      return "unknown";
  }
}

const sandboxListSchema = z.object({
  sandboxes: z.array(sandboxSchema),
  pageInfo: z
    .object({ nextCursor: z.string().nullish(), hasMore: z.boolean() })
    .nullish(),
});

const MAX_LIST_PAGES = 1000;

/** Every sandbox Amika created, optionally narrowed by one more label. */
async function listManagedSandboxes(
  config: BoatConfig,
  extraLabel?: string,
): Promise<BoatSandbox[]> {
  const all: BoatSandbox[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: "200" });
    query.append("label", `${MANAGED_LABEL}=true`);
    if (extraLabel) query.append("label", extraLabel);
    if (cursor) query.set("cursor", cursor);
    const res = await requestJson(
      config,
      sandboxListSchema,
      "GET",
      `/sandboxes?${query.toString()}`,
    );
    all.push(...res.sandboxes);
    if (!res.pageInfo?.hasMore || !res.pageInfo.nextCursor) return all;
    cursor = res.pageInfo.nextCursor;
  }
  throw new Error(`boat listing did not end within ${MAX_LIST_PAGES} pages`);
}

/** Every sandbox Amika created, with its Amika name, org, and size. */
export async function listBoatSandboxes(
  config: BoatConfig,
): Promise<ProviderSandboxListing[]> {
  const listings: ProviderSandboxListing[] = [];
  for (const sandbox of await listManagedSandboxes(config)) {
    const known = BOAT_TYPES.find((t) => t.type === sandbox.type);
    // Without a size the sandbox cannot be priced; skip it.
    if (!known) continue;
    listings.push({
      providerSandboxId: sandbox.id,
      name: sandbox.labels?.[BOAT_NAME_LABEL] ?? sandbox.name,
      orgId: sandbox.labels?.[SANDBOX_ORG_ID_LABEL] ?? null,
      state: sandbox.state,
      sizing: known.resources,
    });
  }
  return listings;
}

const limitsSchema = z.object({
  machineTypes: z.array(z.object({ type: z.string(), available: z.boolean() })),
});

/** Shorter than the client's default: a caller waits on this to offer sizes. */
const SIZES_TIMEOUT_MS = 10_000;

/**
 * The sizes the key's account may start now (`GET /limits`), smallest
 * first. The key needs the `account.read` scope.
 */
export async function listBoatSizes(
  config: BoatConfig,
): Promise<SandboxResources[]> {
  const limits = await requestJson(config, limitsSchema, "GET", "/limits", {
    timeoutMs: SIZES_TIMEOUT_MS,
  });
  const available = new Set(
    limits.machineTypes.filter((t) => t.available).map((t) => t.type),
  );
  return BOAT_TYPES.filter((t) => available.has(t.type)).map(
    (t) => t.resources,
  );
}
