/**
 * Runtime image names must be 1-64 of `a-z`, `0-9`, `.`, `_`, `-`. Amika
 * snapshot names do not follow these rules (they have `/` and uppercase
 * letters).
 *
 * {@link runtimeImageName} keeps a name that is already valid. It changes
 * any other name to a readable slug plus a hash of the full name, so two
 * Amika names never map to the same image. The mapping is deterministic,
 * so a by-name lookup can compute the image name again.
 */
import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 64;
const HASH_LENGTH = 10;
const VALID_NAME = /^[a-z0-9._-]{1,64}$/;

export function runtimeImageName(name: string): string {
  if (VALID_NAME.test(name)) return name;
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LENGTH - HASH_LENGTH - 1)
    .replace(/-+$/, "");
  return slug ? `${slug}-${hash}` : `amika-${hash}`;
}
