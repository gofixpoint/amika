import { afterEach, describe, expect, it } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../logger";
import type { SandboxProvider } from "../provider";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import { getSimulateWorld, resetSimulateWorlds } from "../simulate/provider";
import { Ledger } from "./ledger";
import { trackSnapshot, type TrackingContext } from "./tracking";

const WORLD_ID = "tracking-test";
const DEPS: SandboxProviderDeps = {
  daytona: { apiKey: "", apiUrl: "" },
  e2b: null,
  freestyle: null,
  vercel: null,
  smol: null,
  amikaHostd: null,
  simulate: { worldId: WORLD_ID },
  resolveSnapshotId: async () => null,
};
const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

afterEach(() => resetSimulateWorlds());

function context(provider: SandboxProvider): TrackingContext {
  return {
    ledger: new Ledger(provider.name, () => {}),
    provider,
    snapshotIds: new Map(),
    currentTest: () => "a test",
    isGone: async (check) => check(),
  };
}

async function sourceSandbox(provider: SandboxProvider) {
  return provider.sandboxes.create(ctx, {
    name: "source",
    snapshot: "base",
    services: [],
  });
}

describe("trackSnapshot", () => {
  it("deletes a snapshot whose capture created it and then threw", async () => {
    const provider = createSandboxProvider("simulate", DEPS);
    const tracking = context(provider);
    const source = await sourceSandbox(provider);

    trackSnapshot(tracking, "snap-a");
    // The capture creates the snapshot; the caller never gets it back, so
    // `identify` is never called. The record made before capture is enough.
    await source.snapshots!.create("snap-a");
    expect(getSimulateWorld(WORLD_ID).snapshot("snap-a")).toBeDefined();

    await tracking.ledger.release();
    expect(getSimulateWorld(WORLD_ID).snapshot("snap-a")).toBeUndefined();
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "deleted",
      id: "snap-a",
      verified: true,
    });
  });

  it("deletes a snapshot that `get` cannot see yet but `find` can", async () => {
    const real = createSandboxProvider("simulate", DEPS);
    // A provider whose by-name lookup misses a snapshot still registering.
    const provider: SandboxProvider = {
      ...real,
      snapshots: { ...real.snapshots!, get: async () => null },
    };
    const tracking = context(provider);
    const source = await sourceSandbox(provider);

    const identify = trackSnapshot(tracking, "snap-b");
    identify(await source.snapshots!.create("snap-b"));
    await tracking.ledger.release();

    expect(getSimulateWorld(WORLD_ID).snapshot("snap-b")).toBeUndefined();
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "deleted",
      verified: true,
    });
  });

  it("fails cleanup on an opaque-id provider that never returned the id", async () => {
    const real = createSandboxProvider("simulate", DEPS);
    const provider: SandboxProvider = {
      ...real,
      capabilities: { ...real.capabilities, snapshotIdsAreOpaque: true },
    };
    const tracking = context(provider);

    trackSnapshot(tracking, "snap-c");
    await tracking.ledger.release();

    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "delete_failed",
      id: "snap-c",
      error: expect.stringContaining("never returned a bootable id"),
    });
  });

  it("records the bootable id once capture returns it", () => {
    const provider = createSandboxProvider("simulate", DEPS);
    const tracking = context(provider);
    const identify = trackSnapshot(tracking, "snap-d");
    identify({ name: "snap-d", providerSnapshotId: "snap_99" } as never);
    expect(tracking.snapshotIds.get("snap-d")).toBe("snap_99");
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "identified",
      providerId: "snap_99",
    });
  });
});
