import { AmikaError } from "@/errors";
import type { RemoteSandbox } from "@/types";

/** Default poll interval for sandbox wait helpers (matches Go apiclient). */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 3_000;

/** Options for polling until a sandbox reaches a target state. */
export interface WaitOptions {
  /** Maximum time to wait before throwing. Omit for no client-side timeout. */
  timeoutMs?: number;
  /** Time between poll attempts. Defaults to 3 seconds. */
  pollIntervalMs?: number;
  /** When aborted, waiting stops with an AmikaError. */
  signal?: AbortSignal;
  /** Called after each poll with the latest sandbox record. */
  onPoll?: (sandbox: RemoteSandbox) => void;
}

/**
 * Polls `getSandbox(name)` until the sandbox reaches one of `readyStates`,
 * enters `failed`, times out, or is aborted.
 */
export async function waitForSandboxState(
  getSandbox: (name: string) => Promise<RemoteSandbox>,
  name: string,
  readyStates: readonly string[],
  failMsg: string,
  options?: WaitOptions,
): Promise<RemoteSandbox> {
  const pollIntervalMs =
    options?.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const deadline =
    options?.timeoutMs !== undefined
      ? Date.now() + options.timeoutMs
      : undefined;
  let lastState: string | undefined;

  for (;;) {
    assertNotAborted(options?.signal, name);

    if (deadline !== undefined && Date.now() >= deadline) {
      throw new AmikaError(
        lastState === undefined
          ? `timed out waiting for sandbox "${name}" to reach ${readyStates.join("|")}`
          : `timed out waiting for sandbox "${name}" to reach ${readyStates.join("|")} (last state: ${lastState})`,
      );
    }

    const sb = await getSandbox(name);
    lastState = sb.state;
    options?.onPoll?.(sb);

    if (sb.state === "failed") {
      throw new AmikaError(sb.errorMessage || failMsg);
    }
    if (readyStates.includes(sb.state)) return sb;

    await sleep(pollIntervalMs);
    assertNotAborted(options?.signal, name);
  }
}

function assertNotAborted(signal: AbortSignal | undefined, name: string): void {
  if (signal?.aborted) {
    throw new AmikaError(`waiting for sandbox "${name}" was aborted`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
