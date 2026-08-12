import type { SandboxConfigBase } from "../../config";

export interface FreestyleConfig extends SandboxConfigBase {
  apiKey: string;
  /**
   * Persistence tier for snapshots captured from a sandbox. `"persistent"` (the
   * production default) keeps a snapshot until the user deletes it; `"sticky"`
   * is the platform's best-effort cache tier, which it may evict under storage
   * pressure. Staging sets `"sticky"` so throwaway staging snapshots don't
   * accumulate permanent storage. Omitted defaults to `"persistent"` at the
   * capture call (the safe tier). Mirrors the `--staging` flag of
   * `bin/freestyle-build-snapshots`.
   */
  snapshotPersistence?: "persistent" | "sticky";
}
