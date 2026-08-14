/**
 * Daytona SDK client construction.
 */
import { Daytona } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config";

/**
 * Target used for the experimental sandbox-snapshot APIs
 * (`sandbox._experimental_createSnapshot`, plus creating new sandboxes
 * off those snapshots). Daytona currently gates these capabilities
 * behind this target regardless of which target the existing image-
 * derived snapshots use.
 */
export const EXPERIMENTAL_DAYTONA_TARGET = "experimental";

export interface DaytonaClientOptions {
  /**
   * Override the configured target for this client. Passed-through value
   * is honored verbatim — used to switch to the experimental target for
   * the sandbox-snapshot APIs without rebuilding the entire SDK config.
   */
  target?: string;
}

export function createDaytonaClient(
  config: DaytonaConfig,
  options: DaytonaClientOptions = {},
): Daytona {
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: options.target ?? config.target,
    // Scope every operation to the configured Daytona organization when one is
    // set (`DAYTONA_ORGANIZATION_ID`). Without it the SDK targets the account's
    // default org, so a `daytona.get`/`list` for a sandbox created under a
    // non-default org would come up empty. Spread conditionally so an unset
    // value stays absent rather than forcing the default-org path.
    ...(config.organizationId ? { organizationId: config.organizationId } : {}),
  });
}

/**
 * Build a Daytona client pinned to the experimental target. Required
 * by the `_experimental_createSnapshot` sandbox method and by creating
 * a sandbox from one of those snapshots.
 */
export function createExperimentalDaytonaClient(
  config: DaytonaConfig,
): Daytona {
  return createDaytonaClient(config, { target: EXPERIMENTAL_DAYTONA_TARGET });
}
