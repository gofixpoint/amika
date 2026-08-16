/**
 * Daytona SDK client construction.
 */
import { Daytona } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config";

export function createDaytonaClient(config: DaytonaConfig): Daytona {
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
    // Scope every operation to the configured Daytona organization when one is
    // set (`DAYTONA_ORGANIZATION_ID`). Without it the SDK targets the account's
    // default org, so a `daytona.get`/`list` for a sandbox created under a
    // non-default org would come up empty. Spread conditionally so an unset
    // value stays absent rather than forcing the default-org path.
    ...(config.organizationId ? { organizationId: config.organizationId } : {}),
  });
}
