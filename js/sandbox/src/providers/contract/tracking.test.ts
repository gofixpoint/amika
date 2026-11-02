import { afterEach, describe, expect, it } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../logger";
import type { SandboxProvider } from "../provider";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import { getSimulateWorld, resetSimulateWorlds } from "../simulate/provider";
import { Ledger } from "./ledger";
import {
  trackSandbox,
  trackSnapshot,
  trackSshAccess,
  type TrackingContext,
} from "./tracking";

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

describe("trackSandbox", () => {
  it("records before create and recovers a sandbox after the response is lost", async () => {
    const provider = createSandboxProvider("simulate", DEPS);
    const tracking = context(provider);
    trackSandbox(tracking, "source");
    expect(tracking.ledger.events[0]).toMatchObject({
      event: "created",
      kind: "sandbox",
      id: "source",
    });
    // Create exists remotely, but its caller never received the result.
    const sandbox = await sourceSandbox(provider);
    await tracking.ledger.release();
    expect(await provider.sandboxes.list()).toEqual([]);
    expect(tracking.ledger.events).toContainEqual(
      expect.objectContaining({
        event: "identified",
        kind: "sandbox",
        id: "source",
        providerId: sandbox.id,
      }),
    );
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "deleted",
      verified: true,
    });
  });

  it("uses the returned id even when no sandbox listing is available", async () => {
    const real = createSandboxProvider("simulate", DEPS);
    const provider = {
      ...real,
      capabilities: { ...real.capabilities, listSandboxes: false },
    };
    const tracking = context(provider);
    const identify = trackSandbox(tracking, "source");
    identify(await sourceSandbox(provider));
    await tracking.ledger.release();
    expect(await real.sandboxes.list()).toEqual([]);
  });

  it("fails closed when a failed create cannot be recovered by name", async () => {
    const tracking = context(createSandboxProvider("simulate", DEPS));
    trackSandbox(tracking, "missing");
    await tracking.ledger.release();
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "delete_failed",
      error: expect.stringContaining("check the provider by hand"),
    });
  });

  it("keeps the returned id for cleanup when recording it fails", async () => {
    const real = createSandboxProvider("simulate", DEPS);
    const provider = {
      ...real,
      capabilities: { ...real.capabilities, listSandboxes: false },
    };
    let fail = false;
    const tracking = {
      ...context(provider),
      ledger: new Ledger("simulate", () => {
        if (fail) throw new Error("disk full");
      }),
    };
    const identify = trackSandbox(tracking, "source");
    const sandbox = await sourceSandbox(provider);
    fail = true;
    expect(() => identify(sandbox)).toThrow("disk full");
    fail = false;
    await tracking.ledger.release();
    expect(await real.sandboxes.list()).toEqual([]);
  });
});

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

  it("recovers an opaque id by name when capture never returned it", async () => {
    const real = createSandboxProvider("simulate", DEPS);
    const source = await sourceSandbox(real);
    await source.snapshots!.create("opaque-by-name");
    const provider: SandboxProvider = {
      ...real,
      capabilities: { ...real.capabilities, snapshotIdsAreOpaque: true },
      snapshots: {
        ...real.snapshots!,
        find: async (name) => {
          const snapshot = await real.snapshots!.find(name);
          return snapshot
            ? { ...snapshot, providerSnapshotId: "snap-recovered" }
            : null;
        },
      },
    };
    const tracking = context(provider);
    trackSnapshot(tracking, "opaque-by-name");
    await tracking.ledger.release();
    expect(await real.snapshots!.find("opaque-by-name")).toBeNull();
    expect(tracking.snapshotIds.get("opaque-by-name")).toBe("snap-recovered");
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

describe("recovered identity audit failures", () => {
  it.each(["sandbox", "snapshot"] as const)(
    "still deletes a recovered %s when its identified event cannot be written",
    async (kind) => {
      const real = createSandboxProvider("simulate", DEPS);
      const source = await sourceSandbox(real);
      await source.snapshots!.create("recovered-snapshot");
      const provider: SandboxProvider = {
        ...real,
        snapshots: {
          ...real.snapshots!,
          find: async (name) => {
            const snapshot = await real.snapshots!.find(name);
            return snapshot
              ? { ...snapshot, providerSnapshotId: "snap-recovered" }
              : null;
          },
        },
      };
      const tracking = {
        ...context(provider),
        ledger: new Ledger("simulate", (line) => {
          if (JSON.parse(line).event === "identified")
            throw new Error("identity write failed");
        }),
      };
      if (kind === "sandbox") trackSandbox(tracking, "source");
      else trackSnapshot(tracking, "recovered-snapshot");
      await tracking.ledger.release();
      if (kind === "sandbox") expect(await real.sandboxes.list()).toEqual([]);
      else expect(await real.snapshots!.find("recovered-snapshot")).toBeNull();
      expect(tracking.ledger.events.at(-1)).toMatchObject({
        event: "delete_failed",
        error: "identity write failed",
      });
    },
  );
});

describe("trackSshAccess", () => {
  it("revokes access after the test without writing its token", async () => {
    const provider = createSandboxProvider("simulate", DEPS);
    const lines: string[] = [];
    const tracking = {
      ...context(provider),
      ledger: new Ledger(provider.name, (l) => lines.push(l)),
    };
    const sandbox = await sourceSandbox(provider);
    const access = trackSshAccess(
      tracking,
      sandbox.id,
      await sandbox.ssh!.mint(15),
    );
    expect(getSimulateWorld(WORLD_ID).sshTokensFor(sandbox.id)).toEqual([
      access.token,
    ]);

    await tracking.ledger.release();

    expect(getSimulateWorld(WORLD_ID).sshTokensFor(sandbox.id)).toEqual([]);
    expect(tracking.ledger.events.at(-1)).toMatchObject({
      event: "deleted",
      kind: "ssh-access",
      verified: "unsupported",
    });
    expect(lines.join("\n")).not.toContain(access.token);
  });
});
