/**
 * The firewall rule that lets Amika reach a VM's SSH port.
 *
 * VMs Amika creates carry the `amika-rig` network tag. The rule allows TCP
 * port 22 from anywhere to that tag only; the SSH server takes only key
 * logins. Create makes the rule when it is missing. A service account that
 * may not create firewall rules gets an error that says how to make the
 * rule by hand.
 */
import { z } from "zod";
import {
  GcpApiError,
  isAlreadyExists,
  isNotFound,
  requestJson,
  runOperation,
  type GcpTarget,
} from "./client";

export const GCP_NETWORK_TAG = "amika-rig";
export const GCP_FIREWALL_RULE = "amika-allow-ssh";
export const GCP_NETWORK = "global/networks/default";

/** Projects whose rule this process has seen, so create checks once. */
const ensured = new Set<string>();

export async function ensureGcpSshFirewall(target: GcpTarget): Promise<void> {
  const key = `${target.credentials.keyHash}:${target.projectPath}`;
  if (ensured.has(key)) return;
  const path = `${target.projectPath}/global/firewalls/${GCP_FIREWALL_RULE}`;
  try {
    await requestJson(target, z.object({}).passthrough(), "GET", path);
    ensured.add(key);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await runOperation(
      target,
      "POST",
      `${target.projectPath}/global/firewalls`,
      {
        json: {
          name: GCP_FIREWALL_RULE,
          description: "Lets Amika reach the SSH port of the VMs it creates",
          network: GCP_NETWORK,
          direction: "INGRESS",
          allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
          sourceRanges: ["0.0.0.0/0"],
          targetTags: [GCP_NETWORK_TAG],
        },
      },
    );
  } catch (error) {
    if (!isAlreadyExists(error)) {
      if (error instanceof GcpApiError && error.status === 403) {
        throw new Error(
          `The GCP service account may not create firewall rules. Create rule ` +
            `"${GCP_FIREWALL_RULE}" in the default network yourself: allow ` +
            `tcp:22 to target tag "${GCP_NETWORK_TAG}". (${error.message})`,
        );
      }
      throw error;
    }
  }
  ensured.add(key);
}
