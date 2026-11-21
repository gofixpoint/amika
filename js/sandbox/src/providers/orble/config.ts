import type { SandboxConfigBase } from "../../config";

/** Credentials for the Orble REST API. */
export interface OrbleConfig extends SandboxConfigBase {
  /** An `orble_…` API key. */
  apiKey: string;
  /** API base URL. Omitted: `https://orble.tech`. */
  apiUrl?: string;
}
