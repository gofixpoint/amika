import type { ImageSpec } from "@sailresearch/sdk";
import { z } from "zod";

const SAILBOX_IMAGE_PREFIX = "sail-image:";
const contentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const modeSchema = z.number().int().min(0).max(0o777);
const packageInstallSchema = z
  .object({ packages: z.array(z.string().min(1)).min(1) })
  .strict();
const addLocalFileSchema = z
  .object({
    contentSha256: contentSha256Schema,
    remotePath: z.string().startsWith("/"),
    mode: modeSchema.optional(),
  })
  .strict();
const addLocalDirFileSchema = z
  .object({
    relativePath: z.string().min(1),
    contentSha256: contentSha256Schema,
    mode: modeSchema.optional(),
  })
  .strict();
const addLocalDirSchema = z
  .object({
    remotePath: z.string().startsWith("/"),
    files: z.array(addLocalDirFileSchema),
  })
  .strict();
const imageBuildStepSchema = z.union([
  z.object({ aptInstall: packageInstallSchema }).strict(),
  z.object({ pipInstall: packageInstallSchema }).strict(),
  z
    .object({ runCommand: z.object({ command: z.string().min(1) }).strict() })
    .strict(),
  z.object({ addLocalFile: addLocalFileSchema }).strict(),
  z.object({ addLocalDir: addLocalDirSchema }).strict(),
]);
const imageSpecSchema: z.ZodType<ImageSpec> = z
  .object({
    base: z.enum(["debian", "devbox"]),
    buildSteps: z.array(imageBuildStepSchema).optional(),
    env: z.record(z.string(), z.string()).optional(),
    architecture: z.enum(["amd64", "arm64"]).optional(),
    pythonVersion: z.string().min(1).optional(),
    filesystem: z.enum(["ext4", "btrfs"]).optional(),
  })
  .strict();

/** Encode an SDK image spec into the config-safe value stored per preset. */
export function encodeSailboxImageRef(image: ImageSpec): string {
  return (
    SAILBOX_IMAGE_PREFIX +
    Buffer.from(JSON.stringify(image)).toString("base64url")
  );
}

/** Decode a preset image reference; non-image values are checkpoint ids. */
export function decodeSailboxImageRef(value: string): ImageSpec | null {
  if (!value.startsWith(SAILBOX_IMAGE_PREFIX)) return null;
  const encoded = value.slice(SAILBOX_IMAGE_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    return imageSpecSchema.parse(parsed);
  } catch (cause) {
    throw new Error("Invalid Sailbox image reference", { cause });
  }
}
