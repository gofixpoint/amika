/**
 * Canonical two-track sandbox status model.
 *
 * A sandbox's status is split into two independent tracks so a setup problem
 * can never masquerade as a dead VM:
 *
 *   1. Lifecycle ({@link SandboxStatus}) — is the VM alive? Derived from the
 *      persisted orchestration `state` plus, for settled rows, the live
 *      provider state mapped into the canonical vocabulary
 *      ({@link SandboxStatus}, one mapper per provider).
 *   2. Setup ({@link SandboxSetupStatus}) — did the most recent initialization
 *      run (create or start) set everything up on the VM? Persisted alongside
 *      the sandbox record and only meaningful alongside a live VM.
 *
 *        .
 *        ├── creating
 *        ├── failed
 *        ├── running
 *        │   ├── git-failed
 *        │   ├── ok
 *        │   ├── setup-failed
 *        │   ├── setup-running
 *        │   └── sys-setup-failed
 *        ├── snapshotting
 *        ├── starting
 *        ├── stopping
 *        ├── suspended
 *        └── suspending
 *
 * `failed` therefore means the VM itself is gone or unusable (provisioning
 * failed, provider reports an error state). A sandbox whose repo clone, user
 * setup script, or system setup (credentials, env, API key) failed — but whose
 * VM is up — is `running` with the failure recorded in the setup track.
 *
 * The persisted `state` uses its own vocabulary (`initializing`,
 * `active`, `stopping`, `stopped`, `snapshotting`, `failed`); this module owns
 * the translation into the canonical statuses so persisted rows and mid-deploy
 * version skew all keep working. `snapshotting` is not part of the
 * create/resume taxonomy above but
 * is a real row state a sandbox can occupy, so it is exposed as its own
 * lifecycle status rather than being folded into a neighbor.
 */

/**
 * Outer lifecycle track: is the VM alive (or on its way up/down)? `unknown`
 * means the provider answered but couldn't identify the VM (absent from its
 * listing, unfetchable) or reported a raw state a provider's mapper doesn't
 * recognize — the status is genuinely indeterminate, which is different from
 * both `running` and `failed`.
 */
export const SANDBOX_STATUS_VALUES = [
  "creating",
  "starting",
  "running",
  "stopping",
  "suspending",
  "suspended",
  "snapshotting",
  "failed",
  "unknown",
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUS_VALUES)[number];

/**
 * Setup track: state of the most recent initialization run (create or start).
 * `setup-running` is the in-progress value — the VM is already `running` and
 * reachable (SSH) while clone/setup/post-setup execute in the background; the
 * run then resolves to a terminal outcome. "Last run wins": a successful
 * restart clears an earlier failure, because a restart is the natural retry
 * action and each run re-does the credential/system setup. The one exception is
 * `git-failed` — a restart never re-clones the primary repo, so the
 * missing-workspace status stays sticky across restarts no matter how the rerun
 * goes (see the start flow).
 *
 * `setup-running` is a value under the `running` lifecycle status, not a power
 * state of its own: `deriveSandboxStatus` still reports `running` for it.
 */
export const SANDBOX_SETUP_STATUS_VALUES = [
  "ok",
  "setup-running",
  "git-failed",
  "setup-failed",
  "sys-setup-failed",
] as const;
export type SandboxSetupStatus = (typeof SANDBOX_SETUP_STATUS_VALUES)[number];

/**
 * Narrow a persisted `setup_status` value to the typed union. Returns `null`
 * for anything unexpected and for records that predate the field or haven't
 * recorded an outcome yet.
 */
export function parseSandboxSetupStatus(
  value: string | null | undefined,
): SandboxSetupStatus | null {
  return SANDBOX_SETUP_STATUS_VALUES.includes(value as SandboxSetupStatus)
    ? (value as SandboxSetupStatus)
    : null;
}

/**
 * Whether the sandbox's setup track is still in progress. True only while a
 * create/start run has the VM `running` but is still executing the
 * clone/setup/post-setup lifecycle (`setup-running`). Consumers that need the
 * repo or agent server (agent commands, Slack dispatch, workflow kickoff) must
 * treat this as "not ready yet", and `stop`/`snapshot` refuse while it holds
 * (they would corrupt the in-flight lifecycle). `delete` is intentionally still
 * allowed — it's the way to abort an unwanted or stuck setup, and the
 * background lifecycle tolerates the row/VM disappearing.
 */
export function isSetupInProgress(
  setupStatus: string | null | undefined,
): boolean {
  return parseSandboxSetupStatus(setupStatus) === "setup-running";
}

/**
 * Derive the lifecycle status for a sandbox row, optionally refined by the
 * live provider state (already mapped to the canonical vocabulary by the
 * provider's `mapSandboxState`).
 *
 * The row's orchestration state wins during transitions (initializing,
 * stopping, snapshotting) and terminal failure; a settled `active` row defers
 * to the live VM state, which may disagree with the row (e.g. the provider
 * auto-suspended an idle VM behind our back). Without a usable live state an
 * `active` row reads as `running`.
 *
 * `creating` vs `starting`: both use the row state `initializing`. A row
 * whose setup track is still NULL has never completed an initialization run,
 * so it is mid-create; any later `initializing` (which preserves the previous
 * run's outcome until the new one concludes) is a restart.
 */
export function deriveSandboxStatus(
  row: { state: string; setup_status?: string | null },
  liveState?: SandboxStatus,
): SandboxStatus {
  switch (row.state) {
    case "initializing":
      return row.setup_status == null ? "creating" : "starting";
    case "stopping":
      return "stopping";
    case "stopped":
      return "suspended";
    case "snapshotting":
      return "snapshotting";
    case "failed":
    case "errored": // legacy failure value; no longer written
      return "failed";
    default:
      // "active" (and any unrecognized legacy value, which only `active`-like
      // rows ever carried): defer to the live VM state when we have one —
      // including `unknown` (the provider can't find the VM), which must not
      // read as a healthy `running`. No live state at all (no lifecycle, or
      // the probe itself errored) falls back to the row's word.
      if (liveState !== undefined) {
        // An active row can't be mid-create; a provider reporting a
        // creation-phase state for it is effectively coming up.
        return liveState === "creating" ? "starting" : liveState;
      }
      return "running";
  }
}
