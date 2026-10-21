import { AmikaError } from "../errors.js";
import { pollTiming, sleep, withDeadline } from "../internal/polling.js";
import { bindOperations } from "../internal/resource.js";
import { normalizeRef, type NormalizedRef } from "../internal/resource-ref.js";
import type { ResourceRef } from "../resource-ref.js";
import type { Snapshot, SnapshotHandle } from "./snapshot.js";
import type { RigSnapshot } from "./types.js";

export interface SnapshotTransport {
  get(ref: NormalizedRef, signal?: AbortSignal): Promise<RigSnapshot>;
  delete(ref: NormalizedRef): Promise<void>;
}

export function createSnapshotHandle(
  given: ResourceRef,
  transport: SnapshotTransport,
  data?: RigSnapshot,
): SnapshotHandle {
  const initial = normalizeRef(given, "snapshot");
  const ref = initial.value;
  let snapshot: Snapshot | undefined;
  // Pin the fetched snapshot's ID; before that, use the reference as given.
  const target = (): NormalizedRef =>
    snapshot?.id ? { value: snapshot.id, kind: "id", pinned: true } : initial;
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
