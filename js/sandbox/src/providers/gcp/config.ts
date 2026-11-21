import type { SandboxConfigBase } from "../../config";

/** Credentials and placement for Google Compute Engine VMs. */
export interface GcpConfig extends SandboxConfigBase {
  /**
   * A service account's JSON key, as Google issues it, or that JSON in
   * base64. The key names the project. It may carry one extra field,
   * `zone`, which wins over {@link GcpConfig.zone}.
   */
  apiKey: string;
  /** The zone VMs run in. Omitted: `us-central1-a`. */
  zone?: string;
  /** Compute API base URL. Omitted: `https://compute.googleapis.com`. */
  apiUrl?: string;
}
