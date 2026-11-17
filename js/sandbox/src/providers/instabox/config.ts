import type { SandboxConfigBase } from "../../config";

/** Credentials for the Instabox REST API. */
export interface InstaboxConfig extends SandboxConfigBase {
  apiKey: string;
  /** API base URL. Omitted: `https://api.instabox.sh`. */
  apiUrl?: string;
}
