/**
 * Instabox machine and snapshot names must be 1-63 lowercase letters, digits,
 * or `-`, and start with a letter or digit. They are unique per account.
 * Amika names do not follow these rules (contract names have uppercase
 * letters; org-scoped snapshot names have `/` and `_`).
 *
 * {@link instaboxName} keeps a name that is already valid. It changes any
 * other name to a readable slug plus a hash of the full name, so two Amika
 * names never map to the same Instabox name. The mapping is deterministic, so
 * a by-name lookup can compute the Instabox name again.
 */
import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 63;
const HASH_LENGTH = 10;
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The Instabox name for an Amika sandbox or snapshot name. */
export function instaboxName(name: string): string {
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
