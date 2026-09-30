import { AmikaError, AmikaWaitError } from "@/errors";
import type { RemoteRig, RemoteSandbox } from "@/types";

/** Stable lifecycle states. stopped also matches the API's suspended status. */
export type RigWaitStatus = "running" | "stopped" | "suspended";

export interface RigWaitOptions {
  /** Any listed status matches. Defaults to running. */
  status?: RigWaitStatus | readonly RigWaitStatus[];
  /** Defaults to ok when waiting for running; otherwise setup is not checked. */
  setupStatus?: "ok";
  /** Poll interval in milliseconds. Defaults to 3,000. */
  pollMs?: number;
  /** Total deadline, including HTTP requests, in milliseconds. Defaults to 900,000. */
  maxWaitMs?: number;
}

/** A rig's data plus operations bound to the client that fetched it. */
export interface Rig extends RemoteRig {
  /**
   * Refresh this object until the requested status and setup condition match.
   * Returns this resource on success. Throws AmikaWaitError on lifecycle failure
   * or timeout, so code following await rig.wait() can rely on readiness.
   * HTTP and transport errors propagate without retrying.
   */
  wait(options?: RigWaitOptions): Promise<Rig>;
  /** Delete this rig. HTTP and transport failures propagate to the caller. */
  delete(): Promise<void>;
}

/** @deprecated Use Rig. Plain RemoteSandbox data remains available separately. */
export type Sandbox = RemoteSandbox & Pick<Rig, "wait" | "delete">;

interface RigTransport {
  get(ref: string, signal: AbortSignal): Promise<RemoteRig>;
  delete(ref: string): Promise<void>;
}

/** Attach operations without adding methods or client credentials to serialized data. */
export function createRigResource(
  data: RemoteRig,
  transport: RigTransport,
): Rig {
  const ref = data.id || data.name;
  const rig = Object.defineProperties(data, {
    wait: {
      value: (options?: RigWaitOptions) =>
        waitForRig(rig, ref, transport, options),
    },
    delete: { value: () => transport.delete(ref) },
  }) as Rig;
  return rig;
}

async function waitForRig(
  rig: Rig,
  ref: string,
  transport: RigTransport,
  options: RigWaitOptions = {},
): Promise<Rig> {
  const { statuses, setupStatus, pollMs, maxWaitMs } =
    parseWaitOptions(options);
  const controller = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const timer = setTimeout(() => controller.abort(), maxWaitMs);
  try {
    for (;;) {
      const latest = await Promise.race([
        transport.get(ref, controller.signal),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      Object.assign(rig, latest);
      if (rig.state === "failed" || rig.status === "failed") {
        throw new AmikaWaitError(
          "provisioning",
          rig.errorMessage ||
            `Rig ${ref} failed while waiting for ${statuses.join(" or ")}`,
          rig,
        );
      }
      if (
        setupStatus &&
        ["setup-failed", "git-failed", "sys-setup-failed"].includes(
          rig.setupStatus ?? "",
        )
      ) {
        throw new AmikaWaitError(
          "setup",
          rig.errorMessage || `Rig ${ref} setup failed: ${rig.setupStatus}`,
          rig,
        );
      }
      if (
        statuses.some(
          (status) =>
            status === rig.status ||
            (status === "stopped" && rig.status === "suspended"),
        ) &&
        (!setupStatus || rig.setupStatus === setupStatus)
      ) {
        return rig;
      }
      await sleep(pollMs, controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AmikaWaitError(
        "timeout",
        `Timed out after ${maxWaitMs}ms waiting for rig ${ref} (status: ${rig.status}, setup: ${rig.setupStatus ?? "unknown"})`,
        rig,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseWaitOptions(options: RigWaitOptions) {
  const target = options.status ?? "running";
  const statuses = typeof target === "string" ? [target] : [...target];
  if (
    !statuses.length ||
    statuses.some(
      (status) => !["running", "stopped", "suspended"].includes(status),
    )
  ) {
    throw new AmikaError(
      "wait: status must contain running, stopped, or suspended",
    );
  }
  if (options.setupStatus !== undefined && options.setupStatus !== "ok") {
    throw new AmikaError('wait: setupStatus must be "ok"');
  }
  const setupStatus =
    options.setupStatus ?? (statuses.includes("running") ? "ok" : undefined);
  const pollMs = options.pollMs ?? 3_000;
  const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
  for (const [name, value] of [
    ["pollMs", pollMs],
    ["maxWaitMs", maxWaitMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new AmikaError(
        `wait: ${name} must be a positive integer no greater than 2147483647`,
      );
    }
  }
  return { statuses, setupStatus, pollMs, maxWaitMs };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
