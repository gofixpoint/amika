/** Configuration for macOS VMs run by Lume on the local Mac. */
import type { SandboxConfigBase } from "../../config";

export interface LumeConfig extends SandboxConfigBase {
  /**
   * The Lume storage folder for rig VMs, apart from other Lume VMs on the
   * Mac. Templates stay in Lume's default storage; each rig is a clone here.
   */
  storageDir: string;
  /** Folder for each VM's management key, known hosts, and Lume log. */
  stateDir: string;
  /** The `lume` binary. Defaults to `lume` on PATH. */
  lumeBin?: string;
  /** The `ssh` binary. Defaults to `ssh` on PATH. */
  sshBin?: string;
  /** The template's bootstrap login. Defaults to Lume's `lume` / `lume`. */
  bootstrapUser?: string;
  bootstrapPassword?: string;
  /** Deadline for a boot to reach SSH. Default: 180000. */
  bootTimeoutMs?: number;
}
