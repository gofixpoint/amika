/**
 * Keep a VM's `ssh-keys` metadata in step with its derived SSH key.
 *
 * The key is derived from the service account key (`./ssh-key.ts`), so a
 * rotated or replaced service account key derives a different SSH key, and
 * the one create installed no longer logs in. Start, and a login refused
 * for its key, put the current public key back in the VM's metadata;
 * Google's guest agent installs it within seconds.
 */
import { z } from "zod";
import { requestJson, runOperation, type GcpTarget } from "./client";
import { gcpSshKey, sshKeysMetadata } from "./ssh-key";

const metadataSchema = z.object({
  metadata: z.object({
    fingerprint: z.string(),
    items: z
      .array(z.object({ key: z.string(), value: z.string().optional() }))
      .optional(),
  }),
});

/**
 * Set the VM's `ssh-keys` to the current derived key when it differs.
 * Returns whether it changed anything. The metadata fingerprint makes the
 * write fail rather than overwrite a change made since the read.
 */
export async function ensureGcpSshKeyMetadata(
  target: GcpTarget,
  instanceName: string,
): Promise<boolean> {
  const path = `${target.zonePath}/instances/${encodeURIComponent(instanceName)}`;
  const { metadata } = await requestJson(target, metadataSchema, "GET", path);
  const wanted = sshKeysMetadata(gcpSshKey(target.credentials, instanceName));
  const items = metadata.items ?? [];
  if (items.find((item) => item.key === "ssh-keys")?.value === wanted) {
    return false;
  }
  await runOperation(target, "POST", `${path}/setMetadata`, {
    json: {
      fingerprint: metadata.fingerprint,
      items: [
        ...items.filter((item) => item.key !== "ssh-keys"),
        { key: "ssh-keys", value: wanted },
      ],
    },
  });
  return true;
}
