/**
 * Compute Engine names (VMs, images, firewall rules) must match
 * `[a-z]([-a-z0-9]{0,61}[a-z0-9])?`: 1-63 characters, starting with a letter
 * and not ending with `-`. Amika names do not follow these rules.
 *
 * {@link gcpName} keeps a name that is already valid. It changes any other
 * name to a readable slug plus a hash of the full name, so two Amika names
 * never map to the same Compute Engine name. The mapping is deterministic,
 * so a by-name lookup can compute the name again.
 */
import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 63;
const HASH_LENGTH = 10;
const VALID_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

/** The Compute Engine name for an Amika sandbox or snapshot name. */
export function gcpName(name: string): string {
  if (VALID_NAME.test(name)) return name;
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, MAX_NAME_LENGTH - HASH_LENGTH - 1)
    .replace(/-+$/, "");
  return slug ? `${slug}-${hash}` : `amika-${hash}`;
}
