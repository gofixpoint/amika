import type { SandboxConfigBase } from "../../config";

/** Credentials for the Runtime REST API (https://withruntime.com). */
export interface RuntimeConfig extends SandboxConfigBase {
  /** An `rtkey_…` bearer API key. Key-pair (`rtsk_…`) keys are refused. */
  apiKey: string;
  /** API base URL. Omitted: `https://api.withruntime.com`. */
  apiUrl?: string;
}
