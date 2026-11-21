/**
 * VM operations against the Compute Engine API: create, delete, start, stop,
 * state, and listing
 * (https://cloud.google.com/compute/docs/reference/rest/v1/instances).
 *
 * - **Id.** A VM is addressed by its name, which create picks
 *   (`./names.ts`), so the provider sandbox id is the VM name. Names are
 *   unique per project and zone.
 * - **Size.** An E2 custom machine type with the requested vCPUs and memory.
 *   The boot disk is a balanced persistent disk.
 * - **Metadata.** The exact Amika name, the org, and the create id ride in
 *   instance metadata, which takes any value; Compute Engine labels take
 *   only short lowercase values. The `amika-managed` label marks the VMs the
 *   listing reports.
 * - **Run state.** `stop` powers the VM off (`TERMINATED`; the disk stays).
 *   Compute Engine has no idle timer, so `autoStopInterval` is ignored.
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
import {
  GcpApiError,
  isNotFound,
  requestJson,
  runOperation,
  type GcpTarget,
} from "./client";
import { ensureGcpSshFirewall, GCP_NETWORK, GCP_NETWORK_TAG } from "./firewall";
import { gcpName } from "./names";
import { gcpSshKey, sshKeysMetadata } from "./ssh-key";
import { closeGcpSsh, waitForGcpSsh } from "./ssh";

/** The home of the `amika` user the guest agent creates. */
export const GCP_HOME_DIR = "/home/amika";

/** Metadata keys for what Compute Engine labels cannot hold. */
export const GCP_NAME_METADATA_KEY = "amika-sandbox-name";
const CREATE_ID_METADATA_KEY = "amika-create-id";

/** The label on every VM Amika creates; the listing filters on it. */
const MANAGED_LABEL = "amika-managed";

/** Ubuntu 24.04 LTS, the stock image when a request names no other. */
export const GCP_STOCK_IMAGE =
  "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64";

/** Ubuntu's image needs at least 10 GiB; 20 leaves room for the toolchain. */
const MIN_DISK_GIB = 20;

/** The size a create without `resources` gets. */
const DEFAULT_RESOURCES: SandboxResources = {
  vcpus: 4,
  memoryGib: 8,
  diskGib: MIN_DISK_GIB,
};

const MIB_PER_GIB = 1024;

const instanceSchema = z.object({
  name: z.string(),
  status: z.string(),
  machineType: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  metadata: z
    .object({
      items: z
        .array(z.object({ key: z.string(), value: z.string().optional() }))
        .optional(),
    })
    .optional(),
  disks: z
    .array(
      z.object({
        boot: z.boolean().optional(),
        diskSizeGb: z.string().optional(),
        source: z.string().optional(),
      }),
    )
    .optional(),
});
export type GcpInstance = z.infer<typeof instanceSchema>;

export function instancePath(
  target: GcpTarget,
  name: string,
  suffix = "",
): string {
  return `${target.zonePath}/instances/${encodeURIComponent(name)}${suffix}`;
}

/** The value of metadata item `key`, or undefined. */
export function metadataValue(
  instance: GcpInstance,
  key: string,
): string | undefined {
  return instance.metadata?.items?.find((item) => item.key === key)?.value;
}

/**
 * The E2 custom machine type for `resources`. E2 custom types take an even
 * vCPU count from 2 to 32 and 0.5 to 8 GiB per vCPU, in steps of 256 MiB.
 * Exported for tests.
 */
export function machineTypeFor(zone: string, resources: SandboxResources) {
  const vcpus = resources.vcpus;
  if (!Number.isInteger(vcpus) || vcpus < 2 || vcpus > 32 || vcpus % 2 !== 0) {
    throw new Error(
      `GCP E2 VMs take an even number of vCPUs from 2 to 32, not ${vcpus}`,
    );
  }
  const memMiB = Math.ceil((resources.memoryGib * MIB_PER_GIB) / 256) * 256;
  if (memMiB < vcpus * 512 || memMiB > vcpus * 8 * MIB_PER_GIB) {
    throw new Error(
      `GCP E2 VMs take 0.5 to 8 GiB of memory per vCPU; ` +
        `${resources.memoryGib} GiB for ${vcpus} vCPUs is out of range`,
    );
  }
  return `zones/${zone}/machineTypes/e2-custom-${vcpus}-${memMiB}`;
}

/**
 * The image a VM boots from. `ref` is a full image path (`projects/…`), an
 * image in the VM's own project (`global/images/…`), or the name of one of
 * the project's images. Exported for tests.
 */
export function sourceImageFor(target: GcpTarget, ref: string): string {
  if (!ref) return GCP_STOCK_IMAGE;
  if (ref.startsWith("projects/")) return ref;
  if (ref.startsWith("global/images/")) return `${target.projectPath}/${ref}`;
  return `${target.projectPath}/global/images/${gcpName(ref)}`;
}

/**
 * Create a VM and wait until it takes SSH. A VM that fails on the way is
 * deleted, so it does not cost the org money or quota.
 */
export async function createGcpSandbox(
  ctx: SandboxCtx,
  target: GcpTarget,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  await withStepContext("gcp create: firewall rule", () =>
    ensureGcpSshFirewall(target),
  );
  const name = gcpName(input.name);
  const resources = input.resources ?? DEFAULT_RESOURCES;
  const zone = target.credentials.zone;
  const sshKey = gcpSshKey(target.credentials, name);
  ctx.logger.info(
    { name: input.name, gcpName: name, snapshot: input.snapshot, zone },
    "Creating GCP VM",
  );
  const metadata: Record<string, string> = {
    ...input.labels,
    [GCP_NAME_METADATA_KEY]: input.name,
    [CREATE_ID_METADATA_KEY]: randomUUID(),
    "ssh-keys": sshKeysMetadata(sshKey),
    // The `ssh-keys` item works only without OS Login, which a project or
    // org policy may turn on.
    "enable-oslogin": "FALSE",
    // The guest agent publishes the host keys there (`./ssh.ts`).
    "enable-guest-attributes": "TRUE",
  };
  const body = {
    name,
    machineType: machineTypeFor(zone, resources),
    labels: { [MANAGED_LABEL]: "true" },
    tags: { items: [GCP_NETWORK_TAG] },
    metadata: {
      items: Object.entries(metadata).map(([key, value]) => ({ key, value })),
    },
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: sourceImageFor(target, input.snapshot),
          diskSizeGb: String(
            Math.max(Math.ceil(resources.diskGib), MIN_DISK_GIB),
          ),
          diskType: `zones/${zone}/diskTypes/pd-balanced`,
        },
      },
    ],
    networkInterfaces: [
      {
        network: GCP_NETWORK,
        accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
      },
    ],
  };

  const deleteFailed = () =>
    deleteGcpSandbox(target, name).catch((cleanup: unknown) =>
      ctx.logger.warn(
        { err: cleanup, instance: name },
        "Could not delete a failed GCP VM",
      ),
    );

  try {
    await runOperation(target, "POST", `${target.zonePath}/instances`, {
      json: body,
    });
  } catch (error) {
    // A 4xx before the operation started made no VM. Anything else may
    // have: we picked the name, so delete by it.
    if (!(error instanceof GcpApiError && error.status < 500)) {
      await deleteFailed();
    }
    throw error;
  }
  try {
    await withStepContext("gcp create: wait for SSH", () =>
      waitForGcpSsh(target, name),
    );
  } catch (error) {
    await deleteFailed();
    throw error;
  }
  return {
    provider: "gcp",
    providerSandboxId: name,
    services: input.services,
    // Compute Engine has no env field; provisioning writes the variables
    // to `/etc/environment`.
    envVars: {},
  };
}

/** Get a VM; `null` when it does not exist. */
export async function getGcpInstance(
  target: GcpTarget,
  name: string,
): Promise<GcpInstance | null> {
  try {
    return await requestJson(
      target,
      instanceSchema,
      "GET",
      instancePath(target, name),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Delete a VM and its boot disk. A missing VM is a no-op. */
export async function deleteGcpSandbox(
  target: GcpTarget,
  name: string,
): Promise<void> {
  closeGcpSsh(target, name);
  try {
    await runOperation(target, "DELETE", instancePath(target, name));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Power a VM on (or resume a suspended one) and wait until it takes SSH. */
export async function startGcpSandbox(
  target: GcpTarget,
  name: string,
): Promise<void> {
  const instance = await getGcpInstance(target, name);
  if (!instance) throw new Error(`GCP VM ${name} does not exist`);
  closeGcpSsh(target, name);
  if (instance.status === "SUSPENDED") {
    await runOperation(target, "POST", instancePath(target, name, "/resume"));
  } else if (instance.status !== "RUNNING") {
    await runOperation(target, "POST", instancePath(target, name, "/start"));
  }
  await waitForGcpSsh(target, name);
}

/** Power a VM off. The disk stays. */
export async function stopGcpSandbox(
  target: GcpTarget,
  name: string,
): Promise<void> {
  const instance = await getGcpInstance(target, name);
  if (!instance) throw new Error(`GCP VM ${name} does not exist`);
  if (instance.status === "TERMINATED" || instance.status === "STOPPED") {
    return;
  }
  closeGcpSsh(target, name);
  await runOperation(target, "POST", instancePath(target, name, "/stop"));
}

/** The raw VM status, or `unknown` when the VM does not exist. */
export async function getGcpSandboxState(
  target: GcpTarget,
  name: string,
): Promise<string> {
  return (await getGcpInstance(target, name))?.status ?? "unknown";
}

/** Map a Compute Engine VM status to the canonical status. */
export function mapGcpSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "PROVISIONING":
    case "STAGING":
      return "starting";
    case "RUNNING":
      return "running";
    case "STOPPING":
      return "stopping";
    case "TERMINATED":
    case "STOPPED":
      return "stopped";
    case "SUSPENDING":
      return "suspending";
    case "SUSPENDED":
      return "suspended";
    default:
      // `REPAIRING`, and statuses we do not know.
      return "unknown";
  }
}

const instanceListSchema = z.object({
  items: z.array(instanceSchema).optional(),
  nextPageToken: z.string().optional(),
});

/** Stop paging after this many pages; a server bug must not loop forever. */
const MAX_LIST_PAGES = 1000;

/** Every VM in the zone that Amika created. */
async function listManagedInstances(target: GcpTarget): Promise<GcpInstance[]> {
  const all: GcpInstance[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await requestJson(
      target,
      instanceListSchema,
      "GET",
      `${target.zonePath}/instances`,
      {
        query: {
          filter: `labels.${MANAGED_LABEL}=true`,
          maxResults: "500",
          pageToken,
        },
      },
    );
    all.push(...(res.items ?? []));
    if (!res.nextPageToken) return all;
    pageToken = res.nextPageToken;
  }
  throw new Error(
    `GCP instance listing did not end within ${MAX_LIST_PAGES} pages`,
  );
}

/** The vCPUs and memory of a custom machine type URL, or null. */
export function customMachineTypeSize(
  machineType: string,
): { vcpus: number; memoryGib: number } | null {
  const type = machineType.split("/").pop() ?? "";
  const match = /(?:^|-)custom-(\d+)-(\d+)(?:-ext)?$/.exec(type);
  if (!match) return null;
  return {
    vcpus: Number(match[1]),
    memoryGib: Number(match[2]) / MIB_PER_GIB,
  };
}

/** Every VM Amika created in the zone, with its Amika name, org, and size. */
export async function listGcpSandboxes(
  target: GcpTarget,
): Promise<ProviderSandboxListing[]> {
  const listings: ProviderSandboxListing[] = [];
  for (const instance of await listManagedInstances(target)) {
    const size = instance.machineType
      ? customMachineTypeSize(instance.machineType)
      : null;
    // Without a size the VM cannot be priced; skip it. Every VM Amika
    // creates has a custom type.
    if (!size) continue;
    const bootDisk = instance.disks?.find((d) => d.boot) ?? instance.disks?.[0];
    listings.push({
      providerSandboxId: instance.name,
      name: metadataValue(instance, GCP_NAME_METADATA_KEY) ?? instance.name,
      orgId: metadataValue(instance, SANDBOX_ORG_ID_LABEL) ?? null,
      state: instance.status,
      sizing: { ...size, diskGib: Number(bootDisk?.diskSizeGb ?? 0) },
    });
  }
  return listings;
}
