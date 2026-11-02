/**
 * How the contract suite records resources that can exist before the call
 * that creates them returns. Kept apart from the scenarios so the failure
 * paths (a capture that creates and then throws) can be tested directly.
 */
import type {
  MintedSshHandle,
  Sandbox,
  SandboxProvider,
  Snapshot,
} from "../provider";
import type { Ledger } from "./ledger";

export interface TrackingContext {
  ledger: Ledger;
  provider: SandboxProvider;
  /** Snapshot name -> bootable id, read by the provider's `resolveSnapshotId`. */
  snapshotIds: Map<string, string>;
  currentTest(): string;
  /** Poll until `check` returns true over the settle window; otherwise false. */
  isGone(check: () => Promise<boolean>): Promise<boolean>;
}

/** Record a sandbox by its unique name before create can reach the vendor. */
export function trackSandbox(
  context: TrackingContext,
  name: string,
): (sandbox: Sandbox) => Sandbox {
  const { ledger, provider } = context;
  let sandboxId: string | undefined;
  ledger.track({
    kind: "sandbox",
    id: name,
    name,
    test: context.currentTest(),
    delete: async () => {
      if (!sandboxId) {
        if (!provider.capabilities.listSandboxes) {
          throw new Error(
            `create never returned an id for sandbox ${name}; check the provider by hand`,
          );
        }
        // A timed-out create can still be registering. Give its listing the
        // same settle window as deletion before asking for manual recovery.
        await context.isGone(async () => {
          const found = (await provider.sandboxes.list()).find(
            (s) => s.name === name,
          );
          if (found) sandboxId = found.providerSandboxId;
          return sandboxId !== undefined;
        });
        if (!sandboxId) {
          throw new Error(
            `create never returned an id for sandbox ${name} and its name could not be found; check the provider by hand`,
          );
        }
        ledger.identify("sandbox", name, sandboxId);
      }
      await provider.sandboxes.get(sandboxId).delete();
    },
    verifyGone: provider.capabilities.listSandboxes
      ? () =>
          context.isGone(
            async () =>
              !(await provider.sandboxes.list()).some(
                (s) => s.providerSandboxId === sandboxId,
              ),
          )
      : undefined,
  });
  return (sandbox) => {
    sandboxId = sandbox.id;
    ledger.identify("sandbox", name, sandboxId);
    return sandbox;
  };
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
 * `get` may report one of those as absent. Opaque ids do not rule out a
 * name lookup (E2B and Freestyle support it). If that lookup also fails to
 * recover an opaque id, cleanup fails rather than reporting it gone.
 */
export function trackSnapshot(
  context: TrackingContext,
  name: string,
): (snapshot: Snapshot) => Snapshot {
  const { ledger, provider, snapshotIds } = context;
  const lookup = async () => {
    const snapshot = await provider.snapshots!.find(name);
    if (snapshot?.providerSnapshotId && !snapshotIds.has(name)) {
      snapshotIds.set(name, snapshot.providerSnapshotId);
      ledger.identify("snapshot", name, snapshot.providerSnapshotId);
    }
    if (
      !snapshot &&
      provider.capabilities.snapshotIdsAreOpaque &&
      !snapshotIds.has(name)
    ) {
      throw new Error(
        `capture never returned a bootable id for snapshot ${name}, so it cannot be looked up; check the provider by hand`,
      );
    }
    return snapshot;
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

let sshSequence = 0;

/**
 * Record SSH access the moment it is minted, so it is revoked after the test
 * even when an assertion about it fails first. Revoking twice is fine: the
 * contract makes `revoke` idempotent.
 *
 * The ledger gets a made-up id and the sandbox it belongs to, never the
 * token. That keeps secrets off disk, and it means a killed run's access
 * must be revoked by hand.
 */
export function trackSshAccess(
  context: TrackingContext,
  sandboxId: string,
  access: MintedSshHandle,
): MintedSshHandle {
  sshSequence += 1;
  context.ledger.track({
    kind: "ssh-access",
    id: `${sandboxId}/ssh-${sshSequence}`,
    name: `ssh access to ${sandboxId}`,
    test: context.currentTest(),
    delete: () => access.revoke(),
  });
  return access;
}
