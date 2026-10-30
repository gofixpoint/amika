/** Validate the machine API's requests, the supported subset of smolvm's. */
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import {
  AMIKAD_SERVICE,
  SERVICE_AUTH_MODES,
} from "@amika/service-auth/gateway";
import { PREPULL_MACHINE_PREFIX } from "./prepull.js";
import type { SnapshotState } from "./snapshot-store.js";

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const envSchema = z.array(
  z.strictObject({ name: z.string().min(1), value: z.string() }),
);

// Named guest ports reached through `/v0beta1/rigs/<machine>/services/<name>/...`.
// hostd, not the caller, picks the host side of each, so a caller can never
// bind an arbitrary host port. Several names may share a port. Names are
// Amika's, which allow any text; routes carry them percent-encoded.
//
// `auth` and `preserve_host` say what the service is at its own public name
// (`service-registry.ts`); absent, each is the default. Both are strict
// keys, so a daemon from before them refuses a body that sets one rather
// than serving the service as if it had not. amikad takes neither: it has
// its own rules at its name, whatever a body says.
const serviceSchema = z
  .strictObject({
    // `.` and `..` are dot segments, which no URL can carry as a name.
    name: z
      .string()
      .min(1)
      .max(300)
      .refine((name) => name !== "." && name !== ".."),
    port: z.number().int().min(1).max(65_535),
    auth: z.enum(SERVICE_AUTH_MODES).optional(),
    preserve_host: z.boolean().optional(),
  })
  .refine(
    (service) =>
      service.name !== AMIKAD_SERVICE ||
      (service.auth === undefined && service.preserve_host === undefined),
    `${AMIKAD_SERVICE} takes no auth or preserve_host`,
  );
export type ServiceInput = z.infer<typeof serviceSchema>;

const servicesSchema = z
  .array(serviceSchema)
  .max(16)
  .refine(
    (services) => new Set(services.map((s) => s.name)).size === services.length,
    "duplicate service name",
  );

/**
 * The Amika user id that owns the rig, as the login pass spells it. Only
 * `auth: "owner"` reads it; a rig without one admits nobody that way.
 */
const ownerSchema = z.string().min(1).max(200).optional();

export const createMachineSchema = z.strictObject({
  // The prefix names hostd's own throwaway machines, which it deletes.
  name: nameSchema.refine(
    (name) => !name.startsWith(PREPULL_MACHINE_PREFIX),
    `names starting with ${PREPULL_MACHINE_PREFIX} are reserved`,
  ),
  image: z.string().trim().min(1),
  // smolvm's limits (`VmResources::validate`): it supports at most 16 vCPUs
  // (only macOS actually caps there; we refuse more on every host) and can't
  // boot a VM with under 64 MiB.
  cpus: z.number().int().min(1).max(16).optional(),
  memoryMb: z.number().int().min(64).optional(),
  storageGb: z.number().int().positive().optional(),
  network: z.boolean().default(true),
  env: envSchema.optional(),
  services: servicesSchema.optional(),
  owner: ownerSchema,
});

/**
 * A machine's full service set, replacing the one it was created with. The
 * owner is not among them: a rig's never changes, so the one create named
 * stays.
 */
export const replaceServicesSchema = z.strictObject({
  services: servicesSchema,
});

/**
 * Taking a snapshot of a rig. The name is Amika's, org-scoped and so
 * slash-separated; the store derives every filename from it rather than
 * using it as one.
 */
export const createSnapshotSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

/** Where a machine's filesystem comes from: an image, or a local snapshot. */
export type MachineSource =
  | { image: string; from?: undefined }
  | { image?: undefined; from: string };

/** What `resolveSource` needs of the snapshot store, and nothing more. */
export interface SnapshotSource {
  get(name: string): { state: SnapshotState } | undefined;
  artifact(name: string): string | undefined;
}

/**
 * What smolvm should boot for a create request's `image`, in this order:
 *
 * 1. A name configured under `[preset_images]` becomes its reference.
 * 2. A snapshot this host holds becomes its `.smolmachine` artifact. This is
 *    checked BEFORE the OCI passthrough below because Amika's snapshot names
 *    are namespaced (`org_abc123/sandbox/nightly`) and so contain slashes:
 *    left to the passthrough, every snapshot would be sent to a registry.
 * 3. Anything else that looks like a full OCI reference (a registry path or a
 *    tag) is forwarded unchanged, which keeps ad hoc images working for
 *    development.
 *
 * A bare name that is none of these is refused, so a host never silently
 * pulls `docker.io/library/<name>` in place of an Amika preset.
 */
export function resolveSource(
  image: string,
  images: Record<string, string>,
  snapshots: SnapshotSource,
  configPath: string | undefined,
): MachineSource {
  if (Object.hasOwn(images, image)) return { image: images[image] };
  const snapshot = snapshots.get(image);
  if (snapshot) {
    const from = snapshots.artifact(image);
    // Known, but not bootable: say so rather than let a `capturing` name
    // fall through to a registry pull that fails for an unrelated reason.
    if (!from) {
      throw badRequest(
        snapshot.state === "capturing"
          ? `snapshot ${JSON.stringify(image)} is still being taken on this host`
          : `snapshot ${JSON.stringify(image)} is not usable on this host (${snapshot.state})`,
      );
    }
    return { from };
  }
  if (image.includes("/") || image.includes(":")) return { image };
  throw badRequest(
    `image ${JSON.stringify(image)} is not configured on this host; add it under [preset_images] in ${configPath ?? "the amika-hostd config.toml"}`,
  );
}

function badRequest(message: string): HTTPException {
  return new HTTPException(400, {
    res: Response.json({ error: message }, { status: 400 }),
  });
}

export const execSchema = z.strictObject({
  command: z.array(z.string()).min(1),
  user: z.string().min(1).optional(),
  workdir: z.string().startsWith("/").optional(),
  env: envSchema.optional(),
  stdin: z.string().optional(),
});

/** A machine name from a route, validated. */
export function machineName(name: string): string {
  return nameSchema.parse(name);
}

/**
 * The guest path a files route names: everything after
 * `<machinesRoute>/<name>/files/`, decoded once and validated, as an absolute
 * path.
 */
export function filePath(
  name: string,
  requestPath: string,
  machinesRoute: string,
): string {
  const prefix = `${machinesRoute}/${machineName(name)}/files/`;
  let path: string;
  try {
    path = decodeURIComponent(requestPath.slice(prefix.length));
  } catch {
    throw new HTTPException(400, { message: "Invalid file path" });
  }
  return `/${z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"))
    .refine(
      (value) =>
        !value.split("/").some((part) => part === "." || part === ".."),
    )
    .parse(path)}`;
}
