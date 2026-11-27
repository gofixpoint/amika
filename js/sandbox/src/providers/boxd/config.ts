import type { SandboxConfigBase } from "../../config";

/** Credentials for the boxd API. */
export interface BoxdConfig extends SandboxConfigBase {
  /** A `bxd_…` API key. */
  apiKey: string;
  /** gRPC endpoint. Omitted: `https://boxd.sh:9443` (Frankfurt). */
  apiUrl?: string;
}
