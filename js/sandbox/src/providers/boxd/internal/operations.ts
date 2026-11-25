/**
 * Machine operations through the boxd SDK: create, delete, start, stop,
 * state, listing, and the org's sizes.
 *
 * - **Id.** The machine id (a UUID), which create returns.
 * - **Size.** boxd has four classes, each with a 100 GB disk: 1 vCPU and
 *   4 GiB, 2/8, 4/16, and 8/32. The org's quota caps them.
 * - **Isolation.** Create sets `isolated`, so the machine gets none of the
 *   org's peers, in-VM boxd CLI, credentials, or integrations.
 * - **Run state.** `stop` powers the machine off; its disk stays. boxd can
 *   also suspend an idle machine (RAM kept), set from `autoStopInterval`;
 *   a command wakes it.
 * - **User.** boxd logs in as `boxd`. Create makes the `amika` rig user
 *   (`../../shared/rig-user.ts`) before it returns.
 */
import { randomUUID } from "node:crypto";
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
import type { BoxdConfig } from "../config";
import { boxdClient, isNotFound } from "./client";
import { boxdMachineName } from "./names";
import { boxdShell } from "./shell";

/** The boot source that means boxd's default image (Ubuntu 24.04). */
export const BOXD_BASE_IMAGE = "ubuntu:24.04";

export const BOXD_NAME_LABEL = "amika-sandbox-name";
const MANAGED_LABEL = "amika-managed";
/** A random id for one create, to find a machine whose create answer was lost. */
const CREATE_ID_LABEL = "amika-create-id";

/** boxd label values are at most 256 characters. */
const MAX_LABEL_VALUE_LENGTH = 256;

const GIB = 1024 ** 3;

/** boxd's machine classes, smallest first (https://docs.boxd.sh/guides/resources). */
export const BOXD_SIZES: readonly SandboxResources[] = [
  { vcpus: 1, memoryGib: 4, diskGib: 100 },
  { vcpus: 2, memoryGib: 8, diskGib: 100 },
  { vcpus: 4, memoryGib: 16, diskGib: 100 },
  { vcpus: 8, memoryGib: 32, diskGib: 100 },
];

/** The boxd size config for `resources`; boxd takes only its classes. */
export function boxdSizeFor(resources: SandboxResources): {
  vcpu: number;
  memory: string;
} {
  const match = BOXD_SIZES.find(
    (s) => s.vcpus === resources.vcpus && s.memoryGib === resources.memoryGib,
  );
  if (!match) {
    throw new Error(
      `boxd has no machine with ${resources.vcpus} vCPUs and ` +
        `${resources.memoryGib} GiB; it offers 1/4, 2/8, 4/16, and 8/32`,
    );
  }
  return { vcpu: match.vcpus, memory: `${match.memoryGib}G` };
}

/** Amika's idle-stop minutes as boxd's auto-suspend seconds (0 = off). */
export function autoSuspendSeconds(
  autoStopInterval?: number | null,
): number | undefined {
  if (autoStopInterval == null) return undefined;
  return autoStopInterval <= 0 ? 0 : Math.round(autoStopInterval * 60);
}

/** boxd label rules: drop what boxd would refuse. */
function boxdLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).filter(
      ([key, value]) =>
        /^[a-z0-9](?:[a-z0-9._/-]{0,61}[a-z0-9])?$/.test(key) &&
        !key.startsWith("boxd/") &&
        value.length <= MAX_LABEL_VALUE_LENGTH,
    ),
  );
}

/**
 * Create a machine, wait until it runs commands, and make the `amika`
 * user. A machine that fails on the way is deleted.
 */
export async function createBoxdSandbox(
  ctx: SandboxCtx,
  config: BoxdConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const boxd = boxdClient(config);
  const name = boxdMachineName(input.name);
  const autoSuspend = autoSuspendSeconds(input.autoStopInterval);
  ctx.logger.info(
    { name: input.name, boxdName: name, snapshot: input.snapshot },
    "Creating boxd machine",
  );
  const createId = randomUUID();
  const deleteFailed = (machineId: string) =>
    deleteBoxdSandbox(config, machineId).catch((cleanup: unknown) =>
      ctx.logger.warn(
        { err: cleanup, machineId },
        "Could not delete a failed boxd machine",
      ),
    );
  const request = {
    name,
    ...(input.snapshot && input.snapshot !== BOXD_BASE_IMAGE
      ? { image: input.snapshot }
      : {}),
    isolated: true,
    labels: boxdLabels({
      ...input.labels,
      [BOXD_NAME_LABEL]: input.name,
      [CREATE_ID_LABEL]: createId,
      [MANAGED_LABEL]: "true",
    }),
    config: {
      ...(input.resources ? boxdSizeFor(input.resources) : {}),
      ...(autoSuspend !== undefined ? { autoSuspendTimeout: autoSuspend } : {}),
    },
  };
  let machine: { id: string };
  try {
    machine = await boxd.machines.create(request);
  } catch (error) {
    // boxd may have scheduled the machine before the call failed (a
    // timeout, a reset, or the SDK's retry of a create that went through).
    // The caller gets no id, so find it by its create id and delete it.
    await boxd.machines
      .list({ labels: { [CREATE_ID_LABEL]: createId } })
      .then((found) => Promise.all(found.map((m) => deleteFailed(m.id))))
      .catch((cleanup: unknown) =>
        ctx.logger.warn(
          { err: cleanup },
          "Could not look for a machine after a failed boxd create",
        ),
      );
    throw error;
  }
  try {
    await withStepContext("boxd create: wait until ready", () =>
      boxd.machines.waitUntilReady(machine.id, { timeout: 5 * 60_000 }),
    );
    await withStepContext("boxd create: rig user", () =>
      rigUserOps(boxdShell(config, machine.id)).ensureRigUser(),
    );
  } catch (error) {
    await deleteFailed(machine.id);
    throw error;
  }
  return {
    provider: "boxd",
    providerSandboxId: machine.id,
    services: input.services,
    // No env at create; provisioning writes the variables to
    // `/etc/environment`.
    envVars: {},
  };
}

/** Delete a machine and its disk. A missing machine is a no-op. */
export async function deleteBoxdSandbox(
  config: BoxdConfig,
  machineId: string,
): Promise<void> {
  const boxd = boxdClient(config);
  try {
    await boxd.machines.delete(machineId);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Boot, resume, or wake a machine and wait until it runs commands. */
export async function startBoxdSandbox(
  config: BoxdConfig,
  machineId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const boxd = boxdClient(config);
  const machine = await boxd.machines.get(machineId);
  switch (machine.status) {
    case "stopped":
    case "failed":
      await boxd.machines.start(machineId);
      break;
    case "suspended":
    case "hibernated":
      await boxd.machines.wake(machineId);
      break;
    default:
      break;
  }
  await boxd.machines.waitUntilReady(machineId, { timeout: 5 * 60_000 });
  const autoSuspend = autoSuspendSeconds(autoStopInterval);
  if (autoSuspend !== undefined) {
    await boxd.machines.setAutoSuspendTimeout(machineId, autoSuspend);
  }
  await rigUserOps(boxdShell(config, machineId)).ensureRigUser();
}

/** Power a machine off. Its disk stays; memory and programs do not. */
export async function stopBoxdSandbox(
  config: BoxdConfig,
  machineId: string,
): Promise<void> {
  const boxd = boxdClient(config);
  const machine = await boxd.machines.get(machineId);
  if (machine.status === "stopped") return;
  if (machine.status === "suspended" || machine.status === "hibernated") {
    // boxd cannot stop a sleeping machine; wake it first.
    await boxd.machines.wake(machineId);
  }
  await boxd.machines.stop(machineId);
}

export async function getBoxdSandboxState(
  config: BoxdConfig,
  machineId: string,
): Promise<string> {
  const boxd = boxdClient(config);
  try {
    return (await boxd.machines.get(machineId)).status;
  } catch (error) {
    if (isNotFound(error)) return "unknown";
    throw error;
  }
}

/** Map a boxd machine status to the canonical status. */
export function mapBoxdSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "pending":
    case "starting":
      return "starting";
    case "running":
    case "migrating":
      return "running";
    case "suspended":
    case "hibernated":
      return "suspended";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/** Every machine Amika created, with its Amika name, org, and size. */
export async function listBoxdSandboxes(
  config: BoxdConfig,
): Promise<ProviderSandboxListing[]> {
  const boxd = boxdClient(config);
  const machines = await boxd.machines.list({
    labels: { [MANAGED_LABEL]: "true" },
  });
  return machines.map((machine) => ({
    providerSandboxId: machine.id,
    name: machine.labels[BOXD_NAME_LABEL] ?? machine.name,
    orgId: machine.labels[SANDBOX_ORG_ID_LABEL] ?? null,
    state: machine.status,
    sizing: {
      vcpus: machine.resources.vcpu,
      memoryGib: machine.resources.memoryBytes / GIB,
      diskGib: machine.resources.diskBytes / GIB,
    },
  }));
}

/** The classes the org's quota allows, smallest first. */
export async function listBoxdSizes(
  config: BoxdConfig,
): Promise<SandboxResources[]> {
  const boxd = boxdClient(config);
  const defaults = await boxd.orgs.getMachineDefaults();
  return BOXD_SIZES.filter(
    (s) =>
      s.vcpus <= defaults.ceilingVcpu &&
      s.memoryGib * GIB <= defaults.ceilingMemoryBytes,
  );
}
