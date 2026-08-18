import type { SandboxConfigBase } from "../../config";

/** Configuration for Sail Research's Sailbox provider. */
export interface SailboxConfig extends SandboxConfigBase {
  apiKey: string;
  /** Optional Sailbox control-plane override (distinct from the Sail API). */
  sailboxApiUrl?: string;
  /** Prefix for the per-Amika-organization Sail App used for attribution. */
  appPrefix?: string;
  /** Retention for user-created checkpoints. Defaults to one year. */
  checkpointTtlSeconds?: number;
}
