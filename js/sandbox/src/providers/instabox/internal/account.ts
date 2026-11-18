/**
 * What an Instabox API key's workspace may create. `GET /v1/me` answers for
 * any key: its `allowedSpecs` are the workspace's sizes, the default first,
 * then the plan's sizes and any an Instabox admin granted. A create naming
 * any other size is refused with `spec_not_allowed`.
 */
import { z } from "zod";
import type { SandboxResources } from "../../provider";
import type { InstaboxConfig } from "../config";
import { requestJson } from "./client";
import { MIB_PER_GIB } from "./operations";

/** Shorter than the client's default: a caller waits on this to offer sizes. */
const SIZES_TIMEOUT_MS = 10_000;

const meSchema = z.object({
  allowedSpecs: z
    .array(
      z.object({
        vcpus: z.number().int().positive(),
        memMiB: z.number().int().positive(),
        persistentDiskGiB: z.number().int().positive(),
      }),
    )
    .min(1),
});

/**
 * The sizes a new machine may have with this key, the default first. Disk is
 * the persistent disk a machine of that size starts with.
 */
export async function listInstaboxSizes(
  config: InstaboxConfig,
): Promise<SandboxResources[]> {
  const me = await requestJson(config, meSchema, "GET", "/me", {
    timeoutMs: SIZES_TIMEOUT_MS,
  });
  return me.allowedSpecs.map((spec) => ({
    vcpus: spec.vcpus,
    memoryGib: spec.memMiB / MIB_PER_GIB,
    diskGib: spec.persistentDiskGiB,
  }));
}
