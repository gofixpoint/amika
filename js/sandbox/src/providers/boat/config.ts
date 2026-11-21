import type { SandboxConfigBase } from "../../config";

/** Credentials for the boat REST API. */
export interface BoatConfig extends SandboxConfigBase {
  /** A `boat_…` API key. */
  apiKey: string;
  /** API base URL. Omitted: `https://boat.dev/api/v1`. */
  apiUrl?: string;
}
