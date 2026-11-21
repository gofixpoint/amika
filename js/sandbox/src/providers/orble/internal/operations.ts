/**
 * Box operations against the Orble API: create, delete, start, stop, and
 * state.
 *
 * - **Id.** A box is addressed by its name, which create picks
 *   (`./names.ts`), so the provider sandbox id is the box name.
 * - **Size.** Orble has three sizes: `s` (2 vCPU, 4 GiB), `m` (4/8), and
 *   `l` (8/16), each with a 64 GiB disk.
 * - **Run state.** Orble has no stop: `stop` suspends the box, keeping its
 *   memory and programs, and `start` resumes it. Orble also suspends an
 *   idle box by itself after about 100 seconds, and a command, file call,
 *   or SSH login wakes it. The idle time cannot be set. An
 *   `autoStopInterval` of 0 keeps the box awake (`keep_awake`).
 * - **User.** Orble logs in as `agent`. Create makes the `amika` rig user
 *   (`../../shared/rig-user.ts`) before it returns.
 */
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import { withStepContext } from "../../../util/errorutils";
import type {
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  SandboxResources,
} from "../../provider";
import { rigUserOps } from "../../shared/rig-user";
import type { OrbleConfig } from "../config";
import {
  boxPath,
  boxSchema,
  isNotFound,
  OrbleApiError,
  requestJson,
  send,
  type OrbleBox,
} from "./client";
import { orbleBoxName } from "./names";
import { orbleShell } from "./shell";

/** The boot source that means Orble's own image (Debian 13). */
export const ORBLE_BASE_IMAGE = "debian-13";

/** Orble's sizes, smallest first (https://orble.tech/pricing.md). */
export const ORBLE_SIZES: ReadonlyArray<{
  size: string;
  resources: SandboxResources;
}> = [
  { size: "s", resources: { vcpus: 2, memoryGib: 4, diskGib: 64 } },
  { size: "m", resources: { vcpus: 4, memoryGib: 8, diskGib: 64 } },
  { size: "l", resources: { vcpus: 8, memoryGib: 16, diskGib: 64 } },
];

/** The size with exactly the requested vCPUs and memory. */
export function orbleSizeFor(resources: SandboxResources): string {
  const match = ORBLE_SIZES.find(
    (s) =>
      s.resources.vcpus === resources.vcpus &&
      s.resources.memoryGib === resources.memoryGib,
  );
  if (!match) {
    throw new Error(
      `Orble has no size with ${resources.vcpus} vCPUs and ` +
        `${resources.memoryGib} GiB; it offers 2/4, 4/8, and 8/16`,
    );
  }
  return match.size;
}

/** Create a box and make the `amika` user. A box that fails is deleted. */
export async function createOrbleSandbox(
  ctx: SandboxCtx,
  config: OrbleConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const name = orbleBoxName(input.name);
  const body: Record<string, unknown> = {
    name,
    ...(input.resources ? { size: orbleSizeFor(input.resources) } : {}),
    ...(input.snapshot && input.snapshot !== ORBLE_BASE_IMAGE
      ? { from: input.snapshot }
      : {}),
  };
  ctx.logger.info(
    { name: input.name, orbleName: name, size: body.size },
    "Creating Orble box",
  );
  const deleteFailed = () =>
    deleteOrbleSandbox(config, name).catch((cleanup: unknown) =>
      ctx.logger.warn(
        { err: cleanup, box: name },
        "Could not delete a failed Orble box",
      ),
    );

  try {
    // Create returns once the box runs.
    await requestJson(config, boxSchema, "POST", "/boxes", {
      json: body,
      timeoutMs: 5 * 60_000,
    });
  } catch (error) {
    // A 4xx made no box. Anything else may have: we picked the name, so
    // delete by it.
    if (!(error instanceof OrbleApiError && error.status < 500)) {
      await deleteFailed();
    }
    throw error;
  }
  try {
    if (input.autoStopInterval === 0) await setKeepAwake(config, name, true);
    await withStepContext("orble create: rig user", () =>
      rigUserOps(orbleShell(config, name)).ensureRigUser(),
    );
  } catch (error) {
    await deleteFailed();
    throw error;
  }
  return {
    provider: "orble",
    providerSandboxId: name,
    services: input.services,
    // Orble has no env on create; provisioning writes the variables to
    // `/etc/environment`.
    envVars: {},
  };
}

async function setKeepAwake(
  config: OrbleConfig,
  name: string,
  keepAwake: boolean,
): Promise<void> {
  await requestJson(config, boxSchema, "PATCH", boxPath(name), {
    json: { keep_awake: keepAwake },
  });
}

export async function getOrbleBox(
  config: OrbleConfig,
  name: string,
): Promise<OrbleBox | null> {
  try {
    return await requestJson(config, boxSchema, "GET", boxPath(name));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Delete a box and its disk. A missing box is a no-op. */
export async function deleteOrbleSandbox(
  config: OrbleConfig,
  name: string,
): Promise<void> {
  try {
    const res = await send(config, "DELETE", boxPath(name));
    await res.body?.cancel();
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/**
 * Resume a suspended box. An `autoStopInterval` of 0 keeps it awake; any
 * other value lets Orble suspend it when idle again.
 */
export async function startOrbleSandbox(
  config: OrbleConfig,
  name: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const box = await getOrbleBox(config, name);
  if (!box) throw new Error(`Orble box ${name} does not exist`);
  if (box.state !== "running") {
    await requestJson(config, boxSchema, "POST", boxPath(name, "/resume"), {
      timeoutMs: 5 * 60_000,
    });
  }
  if (autoStopInterval != null) {
    await setKeepAwake(config, name, autoStopInterval === 0);
  }
  await rigUserOps(orbleShell(config, name)).ensureRigUser();
}

/** Suspend a box. Orble keeps its memory and running programs. */
export async function stopOrbleSandbox(
  config: OrbleConfig,
  name: string,
): Promise<void> {
  const box = await getOrbleBox(config, name);
  if (!box) throw new Error(`Orble box ${name} does not exist`);
  if (box.state === "suspended") return;
  await requestJson(config, boxSchema, "POST", boxPath(name, "/suspend"), {
    timeoutMs: 5 * 60_000,
  });
}

export async function getOrbleSandboxState(
  config: OrbleConfig,
  name: string,
): Promise<string> {
  return (await getOrbleBox(config, name))?.state ?? "unknown";
}

/** Map an Orble box state to the canonical status. */
export function mapOrbleSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "creating":
      return "creating";
    case "resuming":
      return "starting";
    case "running":
      return "running";
    case "suspending":
      return "suspending";
    case "suspended":
      return "suspended";
    default:
      return "unknown";
  }
}
