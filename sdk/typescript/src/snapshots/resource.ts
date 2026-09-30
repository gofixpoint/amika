import { AmikaError } from "../errors.js";
import { pollTiming, sleep, withDeadline } from "../internal/polling.js";
import { bindOperations } from "../internal/resource.js";
import type { Snapshot, SnapshotHandle } from "./snapshot.js";
import type { RigSnapshot } from "./types.js";

export interface SnapshotTransport {
  get(ref: string, signal?: AbortSignal): Promise<RigSnapshot>;
  delete(ref: string): Promise<void>;
}

export function createSnapshotHandle(
  ref: string,
  transport: SnapshotTransport,
  data?: RigSnapshot,
): SnapshotHandle {
  if (!ref.trim())
    throw new AmikaError("snapshot name or ID must not be empty");
  let snapshot: Snapshot | undefined;
  const target = () => snapshot?.id || ref;
  const update = (latest: RigSnapshot): Snapshot => {
    if (snapshot) Object.assign(snapshot, latest);
    else
      snapshot = bindOperations(latest, {
        ...operations,
        refresh: operations.fetch,
      });
    return snapshot;
  };
  const operations: SnapshotHandle = {
    fetch: async () => update(await transport.get(target())),
    delete: () => transport.delete(target()),
    wait: async (options = {}) => {
      const { pollMs, maxWaitMs } = pollTiming(options);
      return withDeadline(
        maxWaitMs,
        async (signal) => {
          for (;;) {
            const latest = await transport.get(target(), signal);
            signal.throwIfAborted();
            const current = update(latest);
            if (current.state === "active") return current;
            if (current.state === "failed")
              throw new AmikaError(
                current.errorMessage || "rig snapshot capture failed",
              );
            await sleep(pollMs, signal);
          }
        },
        () =>
          new AmikaError(
            `Timed out after ${maxWaitMs}ms waiting for snapshot ${ref} (state: ${snapshot?.state ?? "unknown"})`,
          ),
      );
    },
  };
  return data ? update(data) : bindOperations({}, operations);
}

export function createSnapshotResource(
  data: RigSnapshot,
  transport: SnapshotTransport,
): Snapshot {
  return createSnapshotHandle(
    data.id || data.snapshot,
    transport,
    data,
  ) as Snapshot;
}
