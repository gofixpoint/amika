/** Configuration for the embedded smolvm engine (the `smolmachines` SDK). */
import type { SandboxConfigBase } from "../../config";

export interface SmolvmSdkConfig extends SandboxConfigBase {
  /** Outbound guest networking for machines this provider creates. Default: false. */
  network?: boolean;
}
