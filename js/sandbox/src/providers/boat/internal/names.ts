/**
 * boat saved snapshot names must be 1-63 lowercase letters, digits, or `-`,
 * start with a letter or digit, and not be one of boat's reserved words.
 * Amika snapshot names do not follow these rules (they have `/` and `_`).
 *
 * {@link boatSnapshotName} keeps a name that is already valid. It changes
 * any other name to a readable slug plus a hash of the full name, so two
 * Amika names never map to the same boat name. The mapping is
 * deterministic, so a by-name lookup can compute the boat name again.
 */
import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 63;
const HASH_LENGTH = 10;
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Names boat keeps for its own commands. */
const RESERVED = new Set([
  "latest",
  "tree",
  "pull",
  "rm",
  "save",
  "current",
  "self",
  "new",
]);

/** The boat saved snapshot name for an Amika snapshot name. */
export function boatSnapshotName(name: string): string {
  if (VALID_NAME.test(name) && !RESERVED.has(name)) return name;
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
