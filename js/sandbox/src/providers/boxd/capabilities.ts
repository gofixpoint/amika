/**
 * boxd capability flags. Kept SDK-free so the client-safe capabilities
 * table (`../capabilities`) can read them.
 *
 * boxd machines are Ubuntu microVMs with a gRPC API for lifecycle,
 * commands (streamed), files, labels, and the org's size quota. A boxd
 * snapshot always keeps memory and running programs, where a scrub cannot
 * remove secrets, so snapshots are off. boxd's HTTPS URLs answer anyone,
 * with no token, so there are no service URLs. An API key cannot link an
 * SSH key, so there is no minted SSH access. Machines can be deleted at a
 * fixed time but not after an idle period, so there is no auto-delete.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const boxdCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: false,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: false,
  scrubCapture: false,
  fullSnapshotCapture: false,
  dockerRegistries: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: false,
  accountSizes: true,
};
