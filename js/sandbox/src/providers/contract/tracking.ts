/**
 * How the contract suite records resources that can exist before the call
 * that creates them returns. Kept apart from the scenarios so the failure
 * paths (a capture that creates and then throws) can be tested directly.
 */
import type { SandboxProvider, Snapshot } from "../provider";
import type { Ledger } from "./ledger";

export interface TrackingContext {
  ledger: Ledger;
  provider: SandboxProvider;
  /** Snapshot name -> bootable id, read by the provider's `resolveSnapshotId`. */
  snapshotIds: Map<string, string>;
  currentTest(): string;
  /** Poll `check` over the settle window; `false` if it never said gone. */
  isGone(check: () => Promise<boolean>): Promise<boolean>;
}

/**
 * Record snapshot `name` before it is captured, and return the function
 * that records its bootable id once capture returns:
 *
 *   const identify = trackSnapshot(name);
 *   const snapshot = identify(await source.snapshots!.create(name));
 *
 * Recording first matters because a capture can create the snapshot and
 * still throw (a VM capture whose source restart fails afterwards). The
 * record then already exists, so the snapshot is still deleted after the
 * test.
 *
 * Lookups use `find`, which also sees a snapshot that is still registering;
 * `get` may report one of those as absent. On a provider with opaque
 * snapshot ids, a snapshot whose id was never returned cannot be looked up
 * at all, so its cleanup fails rather than reporting it gone.
 */
export function trackSnapshot(
  context: TrackingContext,
  name: string,
): (snapshot: Snapshot) => Snapshot {
  const { ledger, provider, snapshotIds } = context;
  const lookup = async () => {
    if (provider.capabilities.snapshotIdsAreOpaque && !snapshotIds.has(name)) {
      throw new Error(
        `capture never returned a bootable id for snapshot ${name}, so it cannot be looked up; check the provider by hand`,
      );
    }
    return provider.snapshots!.find(name);
  };
  ledger.track({
    kind: "snapshot",
    id: name,
    name,
    test: context.currentTest(),
    delete: async () => {
      await (await lookup())?.delete();
    },
    verifyGone: () => context.isGone(async () => (await lookup()) === null),
  });
  return (snapshot) => {
    if (snapshot.providerSnapshotId) {
      snapshotIds.set(name, snapshot.providerSnapshotId);
      ledger.identify("snapshot", name, snapshot.providerSnapshotId);
    }
    return snapshot;
  };
}
