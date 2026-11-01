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

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    providerFor: (_name, resolveSnapshotId) =>
      createSandboxProvider("simulate", { ...DEPS, resolveSnapshotId }),
    isRunAlive: () => false,
    ...overrides,
  };
}

/** A ledger with one sandbox that was created but never deleted. */
async function leakedLedger() {
  const provider = createSandboxProvider("simulate", DEPS);
  const sandbox = await provider.sandboxes.create(ctx, {
    name: "leaked",
    snapshot: "base",
    services: [],
  });
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "sweep-")),
    "audit.jsonl",
  );
  writeFileSync(
    file,
    `${JSON.stringify({
      event: "created",
      kind: "sandbox",
      provider: "simulate",
      id: sandbox.id,
      name: "leaked",
      test: "some test",
      at: "2026-11-01T12:00:00Z",
    })}\n`,
  );
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

describe("sweepRun with SSH access", () => {
  it("leaves SSH access for a person and does not record an outcome", async () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "sweep-")),
      "audit.jsonl",
    );
    const line = JSON.stringify({
      event: "created",
      kind: "ssh-access",
      provider: "simulate",
      id: "sim-vm-000001/ssh-1",
      name: "ssh access to sim-vm-000001",
      test: "t",
      at: "2026-11-01T12:00:00Z",
    });
    writeFileSync(file, `${line}\n`);
    const lines: string[] = [];
    const result = await sweepRun(
      "dead-run",
      file,
      options({ log: (l) => lines.push(l) }),
    );
    expect(result.manual.map((r) => r.id)).toEqual(["sim-vm-000001/ssh-1"]);
    expect(result.outcomes).toEqual([]);
    expect(lines[0]).toMatch(/cannot revoke ssh access to sim-vm-000001/);
    expect(readFileSync(file, "utf8")).toBe(`${line}\n`);
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
