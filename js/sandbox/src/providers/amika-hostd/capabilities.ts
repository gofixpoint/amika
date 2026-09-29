/** Client-safe capabilities for the Smol superset exposed by amika-hostd. */
import type { SandboxProviderCapabilities } from "../provider";
import { smolCapabilities } from "../smol/capabilities";

/**
 * Smol's, plus services: hostd routes to published guest ports, which is also
 * what makes a hostd machine eligible for no-relay SSH through `amikad`.
 */
export const amikaHostdCapabilities: SandboxProviderCapabilities = {
  ...smolCapabilities,
  services: true,
};
