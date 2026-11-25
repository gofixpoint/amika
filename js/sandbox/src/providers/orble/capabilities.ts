/**
 * Orble capability flags. Kept SDK-free so the client-safe capabilities
 * table (`../capabilities`) can read them.
 *
 * Orble boxes are Debian VMs with a REST API for lifecycle (suspend and
 * resume), commands, and files. Commands do not stream. An Orble snapshot
 * always keeps memory and running programs, where a scrub cannot remove
 * secrets, so snapshots are off. A private port answers only a browser
 * signed in to the Orble account and a public port answers anyone, so
 * there are no service URLs. Boxes take no labels, so the listing could not
 * tell Amika's boxes from the account's others, and there is none. Orble
 * has no SSH tokens, no auto-delete, and no endpoint for the account's
 * sizes.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const orbleCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: false,
  exec: true,
  listSandboxes: false,
  streaming: false,
  snapshots: false,
  scrubCapture: false,
  fullSnapshotCapture: false,
  dockerRegistries: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: false,
  accountSizes: false,
};
