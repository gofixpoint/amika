/**
 * Freestyle SDK client construction.
 *
 * A fresh client per operation. Unlike Daytona's, whose client holds a
 * Socket.IO connection and so is memoized per config, a `Freestyle` holds no
 * connection — building one per call costs nothing worth caching. The
 * `Freestyle` class reads its API key from the constructor
 * (we pass the configured key explicitly rather than relying on the
 * `FREESTYLE_API_KEY` env-var singleton).
 */
import { Freestyle } from "freestyle";
import type { FreestyleConfig } from "../config";

/**
 * Generous client-side cap for a single Freestyle HTTP request. The SDK issues
 * bare `fetch` calls with no timeout, so a request that never returns — a
 * `vm.exec` against a VM that never becomes exec-ready, a `vms.delete` on a VM
 * wedged mid-init — blocks forever, stranding a sandbox in `initializing` or
 * hanging a delete with no error. This bounds every call so a hang surfaces as
 * a failure (the error names the operation) instead of an infinite wait.
 *
 * This is a client-side `AbortSignal`, NOT the `timeoutMs` body param `vm.exec`
 * accepts: that param is checked against the account's plan maximum and a
 * request over it is rejected with `TIMEOUT_LIMIT_EXCEEDED` (403), which would
 * break every exec. An abort signal has no such limit. The value is generous
 * enough to cover legitimately slow work (a user setup script's `apt`/`npm`
 * install); it only bites on a genuine hang.
 */
export const FREESTYLE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tighter cap for fast control-plane calls (delete, stop, start, state). These
 * complete in seconds, sit on user-facing paths (a delete click, the sandbox
 * list/detail poll), and have no long-running variant, so they should fail fast
 * on a hang rather than wait out the full {@link FREESTYLE_REQUEST_TIMEOUT_MS}.
 */
export const FREESTYLE_CONTROL_PLANE_TIMEOUT_MS = 2 * 60 * 1000;

export function createFreestyleClient(
  config: FreestyleConfig,
  timeoutMs: number = FREESTYLE_REQUEST_TIMEOUT_MS,
): Freestyle {
  return new Freestyle({
    apiKey: config.apiKey,
    baseUrl: config.apiUrl,
    // Bound every request with a client-side timeout. The SDK never passes its
    // own signal, but honor one if it ever does rather than clobbering it.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      }),
  });
}
