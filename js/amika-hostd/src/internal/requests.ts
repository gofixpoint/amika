/** Validate the supported subset of the smolvm machine API. */
import { z } from "zod";
import { HTTPException } from "hono/http-exception";

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const envSchema = z.array(
  z.strictObject({ name: z.string().min(1), value: z.string() }),
);

export const createMachineSchema = z.strictObject({
  name: nameSchema,
  image: z.string().trim().min(1),
  cpus: z.number().int().min(1).max(255).optional(),
  memoryMb: z.number().int().positive().optional(),
  storageGb: z.number().int().positive().optional(),
  network: z.boolean().default(false),
  env: envSchema.optional(),
});

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
