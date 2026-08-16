/**
 * Daytona SDK client construction.
 */
import { Daytona } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config";

const clients = new WeakMap<DaytonaConfig, Daytona>();

/**
 * The Daytona client for `config`, built once and reused.
 *
 * The SDK client is a connection holder — it opens a socket for sandbox state
 * events — so one client per operation means one socket per operation.
 *
 * Keyed on the config object's identity, not its fields: callers hold one
 * config per process and pass that same object to every operation. A config
 * built per call still yields a client per call, which is wasteful but
 * correct. Entries are weak, so there is nothing to tear down.
 *
 * Don't dispose a client from here — the SDK's `disconnect()` is permanent,
 * and the cache would go on handing out the dead client.
 */
export function getDaytonaClient(config: DaytonaConfig): Daytona {
  const cached = clients.get(config);
  if (cached) {
    return cached;
  }
  const client = new Daytona({
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
  clients.set(config, client);
  return client;
}
