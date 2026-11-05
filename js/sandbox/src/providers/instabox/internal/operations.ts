/**
 * Machine operations against the Instabox API: create, delete, start, stop,
 * state, listing, and files. See https://instabox.sh/docs/api/machines.md and
 * https://instabox.sh/docs/api/lifecycle.md.
 *
 * Run state: our `stop` is an Instabox stop (programs end, files stay; the
 * next start boots fresh). Instabox also pauses ("suspends") a machine on its
 * own after an idle period, and it cannot stop a paused machine, so `stop`
 * resumes a paused machine first. `start` boots a stopped machine and
 * resumes a paused one.
 */
import { z } from "zod";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import type {
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  ProviderSandboxListing,
  ReadFileBytesOptions,
} from "../../provider";
import { readCapped } from "../../shared/capped-read";
import { withStepContext } from "../../../util/errorutils";
import type { InstaboxConfig } from "../config";
import {
  InstaboxApiError,
  InstaboxOperationError,
  isNotFound,
  machinePath,
  machineSchema,
  requestJson,
  requestVoid,
  runOperation,
  send,
  type InstaboxMachine,
} from "./client";
import { instaboxName } from "./names";
import { findInstaboxSnapshotByRawName } from "./snapshot-operations";

/** Instabox keeps no name rules we can rely on, so the exact name rides here. */
export const INSTABOX_NAME_METADATA_KEY = "amika-sandbox-name";

/** The machine user's home (`/data` is the persistent disk). */
export const INSTABOX_HOME_DIR = "/data/home";

/** Instabox snapshot ids start with this; anything else is a template. */
const SNAPSHOT_ID_PREFIX = "sn_";

const MIB_PER_GIB = 1024;

/** Idle-pause bounds on a paid plan, in minutes. */
const MIN_AUTO_SUSPEND_MINUTES = 5;
const MAX_AUTO_SUSPEND_MINUTES = 30;

/**
 * Map Amika's idle-stop interval (minutes) to Instabox's idle pause
 * (`autoSuspendAfterSeconds`). Instabox takes 5 to 30 minutes, or 0 for off.
 * `undefined`: keep the Instabox default.
 */
export function autoSuspendSeconds(
  autoStopInterval?: number | null,
): number | undefined {
  if (autoStopInterval == null) return undefined;
  if (autoStopInterval <= 0) return 0;
  const minutes = Math.min(
    Math.max(Math.round(autoStopInterval), MIN_AUTO_SUSPEND_MINUTES),
    MAX_AUTO_SUSPEND_MINUTES,
  );
  return minutes * 60;
}

/**
 * What a machine boots from: a snapshot id (`sn_…`), the name of one of the
 * account's snapshots (such as an image imported with `instabox snapshot
 * import`), or else a template (`agent-browser`, `ci@<version>`, …).
 */
async function bootSource(
  config: InstaboxConfig,
  ref: string,
): Promise<{ snapshotId: string } | { templateId: string }> {
  if (!ref) throw new Error("Instabox create needs a snapshot or template");
  if (ref.startsWith(SNAPSHOT_ID_PREFIX)) return { snapshotId: ref };
  const snapshot = await findInstaboxSnapshotByRawName(config, ref);
  return snapshot ? { snapshotId: snapshot.id } : { templateId: ref };
}

/**
 * Create a machine. Instabox has no env field on create, so `envVars` are
 * not applied here. Provisioning writes them to `/etc/environment`, as it
 * does on every provider.
 */
export async function createInstaboxSandbox(
  ctx: SandboxCtx,
  config: InstaboxConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const source = await withStepContext(
    "instabox create: resolve boot source",
    () => bootSource(config, input.snapshot),
  );
  const name = instaboxName(input.name);
  ctx.logger.info(
    { name: input.name, instaboxName: name, snapshot: input.snapshot },
    "Creating Instabox machine",
  );
  const autoSuspend = autoSuspendSeconds(input.autoStopInterval);
  const body: Record<string, unknown> = {
    name,
    ...source,
    metadata: { ...input.labels, [INSTABOX_NAME_METADATA_KEY]: input.name },
    // The machine belongs to a tenant, so it must not get the API key
    // owner's personal Vault. We also send no `secrets` or `envSecrets`,
    // so it gets no org Secrets.
    vault: false,
    ...(autoSuspend !== undefined
      ? { autoSuspendAfterSeconds: autoSuspend }
      : {}),
    // Disk size is fixed at create; Instabox grows it later with PATCH.
    ...(input.resources
      ? {
          vcpus: input.resources.vcpus,
          memMiB: Math.round(input.resources.memoryGib * MIB_PER_GIB),
        }
      : {}),
  };

  let machineId: string | null | undefined;
  try {
    const op = await runOperation(config, "POST", "/machines", { json: body });
    machineId = op.machineId;
  } catch (error) {
    // A failed create can leave a machine in `error`. Delete it, so it does
    // not count against the account's machine limit.
    if (error instanceof InstaboxOperationError && error.operation.machineId) {
      await deleteInstaboxSandbox(config, error.operation.machineId).catch(
        (cleanup: unknown) =>
          ctx.logger.warn(
            { err: cleanup, machineId: error.operation.machineId },
            "Could not delete a failed Instabox machine",
          ),
      );
    }
    throw error;
  }
  if (!machineId) throw new Error("Instabox create returned no machine id");

  return {
    provider: "instabox",
    providerSandboxId: machineId,
    services: input.services,
    envVars: {},
  };
}

/** Get a machine; `null` when it does not exist. */
export async function getInstaboxMachine(
  config: InstaboxConfig,
  machineId: string,
): Promise<InstaboxMachine | null> {
  try {
    return await requestJson(
      config,
      machineSchema,
      "GET",
      machinePath(machineId),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Delete a machine and wait until it is gone. A missing machine is a no-op. */
export async function deleteInstaboxSandbox(
  config: InstaboxConfig,
  machineId: string,
): Promise<void> {
  try {
    await runOperation(config, "DELETE", machinePath(machineId), {
      // Instabox refuses a delete that does not name the machine again.
      headers: { "X-Confirm-Delete": machineId },
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function startInstaboxSandbox(
  config: InstaboxConfig,
  machineId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  await runOperation(config, "POST", machinePath(machineId, "/start"));
  const autoSuspend = autoSuspendSeconds(autoStopInterval);
  if (autoSuspend !== undefined) {
    await requestVoid(config, "PATCH", machinePath(machineId), {
      json: { autoSuspendAfterSeconds: autoSuspend },
      idempotent: true,
    });
  }
}

/** Rounds of "wait, resume, stop" before `stop` gives up. */
const MAX_STOP_ROUNDS = 4;

export async function stopInstaboxSandbox(
  config: InstaboxConfig,
  machineId: string,
): Promise<void> {
  for (let round = 0; round < MAX_STOP_ROUNDS; round++) {
    const machine = await getInstaboxMachine(config, machineId);
    if (!machine) {
      throw new Error(`Instabox machine ${machineId} does not exist`);
    }
    switch (machine.state) {
      case "stopped":
        return;
      case "suspending":
      case "suspended":
        // Instabox cannot stop a paused machine. Resume it, then stop it.
        await runOperation(config, "POST", machinePath(machineId, "/start"));
        continue;
      default:
        // `runOperation` waits out an operation that is still running.
        await runOperation(config, "POST", machinePath(machineId, "/stop"));
        continue;
    }
  }
  throw new Error(`Instabox machine ${machineId} did not reach "stopped"`);
}

/** The raw machine state, or `unknown` when the machine does not exist. */
export async function getInstaboxSandboxState(
  config: InstaboxConfig,
  machineId: string,
): Promise<string> {
  return (await getInstaboxMachine(config, machineId))?.state ?? "unknown";
}

/** Map an Instabox machine state to the canonical status. */
export function mapInstaboxSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "creating":
      return "creating";
    case "starting":
    case "resuming":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "suspending":
      return "suspending";
    case "suspended":
      return "suspended";
    case "error":
      return "failed";
    default:
      // `deleting`, and states we do not know.
      return "unknown";
  }
}

const machineListSchema = z.object({
  machines: z.array(machineSchema),
  nextCursor: z.string().nullish(),
});

/** Stop paging after this many pages; a server bug must not loop forever. */
const MAX_LIST_PAGES = 1000;

/** Every machine in the account, with its Amika name, org, and size. */
export async function listInstaboxSandboxes(
  config: InstaboxConfig,
): Promise<ProviderSandboxListing[]> {
  const listings: ProviderSandboxListing[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { machines, nextCursor } = await requestJson(
      config,
      machineListSchema,
      "GET",
      "/machines",
      { query: { limit: "100", cursor } },
    );
    for (const machine of machines) {
      // Without a size the machine cannot be priced; skip it.
      if (!machine.spec) continue;
      listings.push({
        providerSandboxId: machine.id,
        name: machine.metadata?.[INSTABOX_NAME_METADATA_KEY] ?? machine.name,
        orgId: machine.metadata?.[SANDBOX_ORG_ID_LABEL] ?? null,
        state: machine.state,
        sizing: {
          vcpus: machine.spec.vcpus,
          memoryGib: machine.spec.memMiB / MIB_PER_GIB,
          diskGib:
            (machine.spec.persistentDiskGiB ?? 0) +
            (machine.spec.rootDiskGiB ?? 0),
        },
      });
    }
    if (!nextCursor) return listings;
    cursor = nextCursor;
  }
  throw new Error(
    `Instabox machine listing did not end within ${MAX_LIST_PAGES} pages`,
  );
}

/** Timeout for one file transfer. */
const FILE_TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** A file's bytes; `null` when it does not exist. */
export async function readInstaboxFile(
  config: InstaboxConfig,
  machineId: string,
  filePath: string,
  opts?: ReadFileBytesOptions,
): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await send(config, "GET", machinePath(machineId, "/files/content"), {
      query: { path: filePath },
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!res.body) return new Uint8Array();
  return readCapped(res.body, filePath, opts?.maxBytes);
}

/** Write a file as the machine user, creating parent directories. */
export async function writeInstaboxFile(
  config: InstaboxConfig,
  machineId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const raw =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
  await requestVoid(config, "PUT", machinePath(machineId, "/files"), {
    query: { path: filePath, parents: "true" },
    raw,
    timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
  });
}

/** True when `error` is an Instabox "you may not read this" answer. */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof InstaboxApiError && error.status === 403;
}
