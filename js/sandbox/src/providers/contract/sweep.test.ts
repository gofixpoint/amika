import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../logger";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import { getSimulateWorld, resetSimulateWorlds } from "../simulate/provider";
import { parseLedger } from "./ledger";
import { runProcessAlive, sweepRun, type SweepOptions } from "./sweep";

const WORLD_ID = "sweep-test";
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

const IDENTITY = { provider: "simulate", worldId: WORLD_ID };
const HEADER = JSON.stringify({
  event: "run",
  provider: "simulate",
  target: IDENTITY,
  at: "2026-11-01T11:59:00Z",
});

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    providerFor: (_name, resolveSnapshotId) =>
      createSandboxProvider("simulate", { ...DEPS, resolveSnapshotId }),
    identityFor: () => IDENTITY,
    isRunAlive: () => false,
    ...overrides,
  };
}

function ledgerFile(...lines: object[]): string {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "sweep-")),
    "audit.jsonl",
  );
  writeFileSync(
    file,
    [HEADER, ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n",
  );
  return file;
}

/** A ledger with one sandbox that was created but never deleted. */
async function leakedLedger() {
  const provider = createSandboxProvider("simulate", DEPS);
  const sandbox = await provider.sandboxes.create(ctx, {
    name: "leaked",
    snapshot: "base",
    services: [],
  });
  const file = ledgerFile({
    event: "created",
    kind: "sandbox",
    provider: "simulate",
    id: sandbox.id,
    name: "leaked",
    test: "some test",
    at: "2026-11-01T12:00:00Z",
  });
  return { provider, sandbox, file };
}

describe("sweepRun", () => {
  it("deletes a leaked sandbox and records the swept outcome in the ledger", async () => {
    const { provider, sandbox, file } = await leakedLedger();
    const result = await sweepRun("dead-run", file, options());
    expect(result.leaked.map((r) => r.id)).toEqual([sandbox.id]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        event: "deleted",
        id: sandbox.id,
        verified: true,
        swept: true,
      }),
    ]);
    expect(await provider.sandboxes.list()).toEqual([]);
    expect(parseLedger(readFileSync(file, "utf8")).at(-1)).toMatchObject({
      event: "deleted",
      swept: true,
    });
  });

  it("skips a run whose process is still alive", async () => {
    const { provider, file } = await leakedLedger();
    const result = await sweepRun(
      "live-run",
      file,
      options({ isRunAlive: () => true }),
    );
    expect(result.skipped).toBe("alive");
    expect(await provider.sandboxes.list()).toHaveLength(1);
  });

  it("only lists on a dry run", async () => {
    const { provider, file } = await leakedLedger();
    const lines: string[] = [];
    const result = await sweepRun(
      "dead-run",
      file,
      options({ dryRun: true, log: (l) => lines.push(l) }),
    );
    expect(result.outcomes).toEqual([]);
    expect(lines[0]).toMatch(/would delete sandbox/);
    expect(await provider.sandboxes.list()).toHaveLength(1);
  });

  it("records a delete the provider rejects as failed", async () => {
    const { file } = await leakedLedger();
    getSimulateWorld(WORLD_ID).failAlways("delete", "quota locked");
    const result = await sweepRun("dead-run", file, options());
    expect(result.outcomes[0]).toMatchObject({
      event: "delete_failed",
      error: "quota locked",
      swept: true,
    });
  });

  it("does nothing for a ledger with no leaks", async () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "sweep-")),
      "audit.jsonl",
    );
    writeFileSync(file, "");
    expect(await sweepRun("clean", file, options())).toEqual({
      runId: "clean",
      leaked: [],
      outcomes: [],
      manual: [],
    });
  });
});

describe("sweepRun target checks", () => {
  it("refuses a run recorded against a different target", async () => {
    const { provider, file } = await leakedLedger();
    const result = await sweepRun(
      "dead-run",
      file,
      options({
        identityFor: () => ({ provider: "simulate", worldId: "other" }),
      }),
    );
    expect(result.refused).toMatch(
      /worldId: run had "sweep-test", now "other"/,
    );
    expect(result.outcomes).toEqual([]);
    expect(await provider.sandboxes.list()).toHaveLength(1);
  });

  it("refuses a ledger with no run header", async () => {
    const { provider, file } = await leakedLedger();
    writeFileSync(
      file,
      readFileSync(file, "utf8").split("\n").slice(1).join("\n"),
    );
    const result = await sweepRun("dead-run", file, options());
    expect(result.refused).toMatch(/no run header/);
    expect(await provider.sandboxes.list()).toHaveLength(1);
  });
});

describe("sweepRun with snapshots", () => {
  async function leakedSnapshot(name: string) {
    const provider = createSandboxProvider("simulate", DEPS);
    const source = await provider.sandboxes.create(ctx, {
      name: "src",
      snapshot: "base",
      services: [],
    });
    await source.snapshots!.create(name);
    return ledgerFile({
      event: "created",
      kind: "snapshot",
      provider: "simulate",
      id: name,
      name,
      test: "t",
      at: "2026-11-01T12:00:00Z",
    });
  }

  it("deletes a snapshot `get` misses but `find` sees, and verifies with `find`", async () => {
    const file = await leakedSnapshot("snap-registering");
    const result = await sweepRun(
      "dead-run",
      file,
      options({
        providerFor: (_name, resolveSnapshotId) => {
          const real = createSandboxProvider("simulate", {
            ...DEPS,
            resolveSnapshotId,
          });
          return {
            ...real,
            snapshots: { ...real.snapshots!, get: async () => null },
          };
        },
      }),
    );
    expect(
      getSimulateWorld(WORLD_ID).snapshot("snap-registering"),
    ).toBeUndefined();
    expect(result.outcomes[0]).toMatchObject({
      event: "deleted",
      verified: true,
    });
  });

  it("fails rather than reports gone when an opaque id was never recorded", async () => {
    const file = await leakedSnapshot("snap-opaque");
    const result = await sweepRun(
      "dead-run",
      file,
      options({
        providerFor: (_name, resolveSnapshotId) => {
          const real = createSandboxProvider("simulate", {
            ...DEPS,
            resolveSnapshotId,
          });
          return {
            ...real,
            capabilities: { ...real.capabilities, snapshotIdsAreOpaque: true },
          };
        },
      }),
    );
    expect(result.outcomes[0]).toMatchObject({
      event: "delete_failed",
      error: expect.stringContaining("no bootable id was recorded"),
    });
    expect(getSimulateWorld(WORLD_ID).snapshot("snap-opaque")).toBeDefined();
  });
});

describe("sweepRun with SSH access", () => {
  it("leaves SSH access for a person and does not record an outcome", async () => {
    const file = ledgerFile({
      event: "created",
      kind: "ssh-access",
      provider: "simulate",
      id: "sim-vm-000001/ssh-1",
      name: "ssh access to sim-vm-000001",
      test: "t",
      at: "2026-11-01T12:00:00Z",
    });
    const before = readFileSync(file, "utf8");
    const lines: string[] = [];
    const result = await sweepRun(
      "dead-run",
      file,
      options({ log: (l) => lines.push(l) }),
    );
    expect(result.manual.map((r) => r.id)).toEqual(["sim-vm-000001/ssh-1"]);
    expect(result.outcomes).toEqual([]);
    expect(lines[0]).toMatch(/cannot revoke ssh access to sim-vm-000001/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("runProcessAlive", () => {
  it("sees this process as alive and a nonsense id as dead", () => {
    expect(
      runProcessAlive(`20260101T000000Z-${process.pid.toString(36)}`),
    ).toBe(true);
    expect(runProcessAlive("not-a-run")).toBe(false);
  });
});
