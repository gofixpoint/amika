/** Validate the supported subset of the smolvm machine API. */
import { z } from "zod";
import { HTTPException } from "hono/http-exception";

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const envSchema = z.array(
  z.strictObject({ name: z.string().min(1), value: z.string() }),
);

// Named guest ports reached through `/rigs/<machine>/services/<name>/...`.
// hostd, not the caller, picks the host side of each, so a caller can never
// bind an arbitrary host port. Several names may share a port. Names are
// Amika's, which allow any text; routes carry them percent-encoded.
const servicesSchema = z
  .array(
    z.strictObject({
      // `.` and `..` are dot segments, which no URL can carry as a name.
      name: z
        .string()
        .min(1)
        .max(300)
        .refine((name) => name !== "." && name !== ".."),
      port: z.number().int().min(1).max(65_535),
    }),
  )
  .max(16)
  .refine(
    (services) => new Set(services.map((s) => s.name)).size === services.length,
    "duplicate service name",
  );

export const createMachineSchema = z.strictObject({
  name: nameSchema,
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
});

/** A machine's full service set, replacing the one it was created with. */
export const replaceServicesSchema = z.strictObject({
  services: servicesSchema,
});

/**
 * The image smolvm should boot for a create request's `image`. A name
 * configured under `[images]` becomes its configured reference. Anything else
 * that looks like a full OCI reference (it has a registry path or a tag) is
 * forwarded unchanged, which keeps ad hoc images working for development. A
 * bare name that isn't configured is refused, so a host never silently pulls
 * `docker.io/library/<name>` in place of an Amika preset.
 */
export function resolveImage(
  image: string,
  images: Record<string, string>,
  configPath: string | undefined,
): string {
  if (Object.hasOwn(images, image)) return images[image];
  if (image.includes("/") || image.includes(":")) return image;
  const message = `image ${JSON.stringify(image)} is not configured on this host; add it under [images] in ${configPath ?? "the amika-hostd config.toml"}`;
  throw new HTTPException(400, {
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

export function machinePath(name: string): string {
  return `/${nameSchema.parse(name)}`;
}

/** Decode once, validate, then encode each component for the upstream URL. */
export function filePath(name: string, requestPath: string): string {
  const prefix = machinePath(name);
  const encoded = requestPath.split("/").slice(6).join("/");
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    throw new HTTPException(400, { message: "Invalid file path" });
  }
  const parts = z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"))
    .refine(
      (value) =>
        !value.split("/").some((part) => part === "." || part === ".."),
    )
    .parse(path)
    .split("/");
  return `${prefix}/files/${parts.map(encodeURIComponent).join("/")}`;
}
