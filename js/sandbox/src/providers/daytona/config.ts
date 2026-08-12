import type { SandboxConfigBase } from "../../config";

export interface DaytonaConfig extends SandboxConfigBase {
  apiKey: string;
  apiUrl: string;
  target?: string;
  organizationId?: string;
  /**
   * Provision Daytona resources as VMs (`SandboxClass.LINUX_VM`) instead of the
   * default container class (`ENABLE_DAYTONA_VM`): new sandboxes are created
   * with `class: "linux-vm"`, and snapshots are captured cold from the stopped
   * VM. Off/undefined means container sandboxes. Daytona only accepts the VM
   * class on the create/snapshot calls the high-level SDK wrapper doesn't
   * expose, so the VM paths reach the generated api-client directly (see
   * `./internal/vm`).
   */
  useVm?: boolean;
}
