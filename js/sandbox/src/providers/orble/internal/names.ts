/**
 * Orble box names: Orble's docs give no rules, but its API takes 2 to 32
 * characters of `a-z`, `0-9`, and `-` ("use 2 to 32 lowercase letters,
 * digits and hyphens"). {@link orbleBoxName} keeps a name already made of
 * those. It changes any other name, including every `<rig>--<id>` name
 * Amika sends, which is longer, to a readable slug plus a hash of the full
 * name, so two Amika names never map to the same box. The box name is also
 * its id, and it is part of the box's hostname.
 */
import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 32;
const HASH_LENGTH = 10;
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function orbleBoxName(name: string): string {
  if (VALID_NAME.test(name)) return name;
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LENGTH - HASH_LENGTH - 1)
    .replace(/-+$/, "");
  return slug ? `${slug}-${hash}` : `amika-${hash}`;
}
