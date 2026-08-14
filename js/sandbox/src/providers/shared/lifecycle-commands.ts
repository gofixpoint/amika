/**
 * The wrapped hook command sequence a lifecycle run executes.
 *
 * Installing the user lifecycle scripts (`setup.sh`/`start.sh`) and resetting
 * them before a snapshot are Amika-specific concerns handled in
 * `@amika/sandbox-provisioning`. This module is the provider-agnostic hook
 * command builder, which the Vercel resume path in core
 * (`vercel/operations.ts`'s `restartVercelServicesOnResume`) also depends on —
 * so it lives in core, where the provisioning package can import it without a
 * circular import.
 */
import {
  POST_SETUP_SCRIPT,
  PRE_SETUP_SCRIPT,
  RUN_HOOK_SCRIPT,
  SANDBOX_SETUP_SCRIPT,
  SANDBOX_START_SCRIPT,
} from "../../constants";

/**
 * The wrapped hook command sequence a lifecycle run executes (pre-setup →
 * setup/start → post-setup). Each is `run-hook.sh <hook>` so the on-box wrapper
 * captures per-hook logs. Provider-agnostic; consumed by the provisioning
 * package's `runLifecycleScripts` and by the Vercel resume path in
 * `@amika/sandbox` (which re-runs the start-phase hooks).
 */
export function buildLifecycleCommands(): {
  preSetup: string;
  setup: string;
  postSetup: string;
  start: string;
} {
  return {
    preSetup: `${RUN_HOOK_SCRIPT} ${PRE_SETUP_SCRIPT}`,
    setup: `${RUN_HOOK_SCRIPT} ${SANDBOX_SETUP_SCRIPT}`,
    postSetup: `${RUN_HOOK_SCRIPT} ${POST_SETUP_SCRIPT}`,
    start: `${RUN_HOOK_SCRIPT} ${SANDBOX_START_SCRIPT}`,
  };
}
