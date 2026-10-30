import type { SandboxConfigBase } from "../../config";

/**
 * Configuration for the in-memory `simulate` provider.
 *
 * The provider keeps no credentials: every sandbox lives in a process-wide
 * {@link SimulateWorld} selected by `worldId`. Two callers that build the
 * provider with the same `worldId` share one world, so a test (or a control
 * API) can inject faults and advance the clock for the sandboxes the server
 * created.
 */
export interface SimulateConfig extends SandboxConfigBase {
  /** Which world this provider operates on. Defaults to `"default"`. */
  worldId?: string;
}
