import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../logger";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import { resetSimulateWorlds } from "../simulate/provider";
import { sweepActionsRun, type ActionsClient } from "./actions-ledgers";
import { parseLedger } from "./ledger";
import { reportSweepResults } from "./sweep-report";
import type { SweepOptions } from "./sweep";

const REPOSITORY = "gofixpoint/amika";
const RUN = {
  id: 123,
  status: "completed",
  event: "workflow_dispatch",
  run_attempt: 2,
  head_branch: "main",
  head_sha: "source-sha",
  head_repository: { full_name: REPOSITORY },
};
const IDENTITY = { provider: "simulate", worldId: "actions-ledger-test" };
const DEPS: SandboxProviderDeps = {
  daytona: { apiKey: "", apiUrl: "" },
  e2b: null,
  freestyle: null,
  vercel: null,
  smol: null,
  amikaHostd: null,
  simulate: { worldId: IDENTITY.worldId },
  resolveSnapshotId: async () => null,
};
const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

afterEach(() => {
  resetSimulateWorlds();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function fixture() {
  const directory = path.join(
    mkdtempSync(path.join(tmpdir(), "actions-ledger-")),
    "download",
  );
  const provider = createSandboxProvider("simulate", DEPS);
  const sandbox = await provider.sandboxes.create(ctx, {
    name: "actions-source",
    snapshot: "base",
    services: [],
  });
  // This PID really is alive here; it must not guard a finished remote run.
  const runId = `20261102T000000Z-${process.pid.toString(36)}`;
  const file = path.join(directory, runId, "audit.jsonl");
  const at = "2026-11-02T00:00:00Z";
  const lines = [
    { event: "run", provider: "simulate", target: IDENTITY, at },
    {
      event: "created",
      kind: "sandbox",
      provider: "simulate",
      id: sandbox.id,
      name: "actions-source",
      test: "vendor test",
      at,
    },
  ];
  let reads = 0;
  const runs = [RUN, RUN];
  const client: ActionsClient = {
    json: vi.fn(async (endpoint) =>
      endpoint.endsWith("/123") ? runs[reads++] : { default_branch: "main" },
    ),
    download: vi.fn(async () => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        lines.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }),
  };
  const options: SweepOptions = {
    providerFor: vi.fn(() => provider),
    identityFor: () => IDENTITY,
    isRunAlive: vi.fn(() => {
      throw new Error("must not inspect a local PID");
    }),
  };
  const input = { repository: REPOSITORY, runId: 123, directory };
  return {
    directory,
    provider,
    sandbox,
    file,
    lines,
    runs,
    client,
    options,
    input,
  };
}

describe("Actions ledger recovery", () => {
  it("downloads the latest attempt and sweeps despite an unrelated live local PID", async () => {
    const f = await fixture();
    const results = await sweepActionsRun(f.input, f.client, f.options);
    expect(f.client.download).toHaveBeenCalledWith(
      REPOSITORY,
      123,
      "sandbox-contract-ledgers-2",
      f.directory,
    );
    expect(f.options.isRunAlive).not.toHaveBeenCalled();
    expect(await f.provider.sandboxes.list()).toEqual([]);
    expect(results[0].outcomes[0]).toMatchObject({
      event: "deleted",
      verified: true,
      swept: true,
    });
    expect(parseLedger(readFileSync(f.file, "utf8")).at(-1)).toMatchObject({
      event: "deleted",
      swept: true,
    });
  });

  it("allows a saved artifact from a named older attempt", async () => {
    const f = await fixture();
    await sweepActionsRun(
      { ...f.input, artifactName: "sandbox-contract-ledgers-1" },
      f.client,
      f.options,
    );
    expect(f.client.download).toHaveBeenCalledWith(
      REPOSITORY,
      123,
      "sandbox-contract-ledgers-1",
      f.directory,
    );
  });

  it.each([
    { status: "in_progress" },
    { status: "queued" },
    { event: "pull_request" },
    { event: "pull_request_target" },
    { head_branch: "untrusted-branch" },
    { head_repository: { full_name: "somebody/fork" } },
    { id: 999 },
  ])("refuses an unsafe source before downloading: %j", async (change) => {
    const f = await fixture();
    f.runs[0] = { ...RUN, ...change };
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      /refusing|requested repository/,
    );
    expect(f.client.download).not.toHaveBeenCalled();
    expect(f.options.providerFor).not.toHaveBeenCalled();
    expect(await f.provider.sandboxes.list()).toHaveLength(1);
  });

  it.each([
    { status: "in_progress" },
    { run_attempt: 3 },
    { head_sha: "different" },
  ])("rechecks after download: %j", async (change) => {
    const f = await fixture();
    f.runs[1] = { ...RUN, ...change };
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      /active|changed/,
    );
    expect(f.options.providerFor).not.toHaveBeenCalled();
  });

  it("keeps dry-run ledgers unchanged", async () => {
    const f = await fixture();
    const results = await sweepActionsRun(f.input, f.client, {
      ...f.options,
      dryRun: true,
    });
    expect(results[0].outcomes).toEqual([]);
    expect(parseLedger(readFileSync(f.file, "utf8"))).toHaveLength(2);
    expect(await f.provider.sandboxes.list()).toHaveLength(1);
  });

  it("retains target checks and fails the command for a different account", async () => {
    const f = await fixture();
    const results = await sweepActionsRun(f.input, f.client, {
      ...f.options,
      identityFor: () => ({ ...IDENTITY, worldId: "other" }),
    });
    expect(results[0].refused).toMatch(/different target/);
    reportSweepResults(results, f.directory, false);
    expect(process.exitCode).toBe(1);
    expect(f.options.providerFor).not.toHaveBeenCalled();
    expect(await f.provider.sandboxes.list()).toHaveLength(1);
  });

  it("reports missing or expired artifacts rather than succeeding with no resources", async () => {
    const f = await fixture();
    vi.mocked(f.client.download).mockRejectedValue(
      new Error("artifact expired"),
    );
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      "artifact expired",
    );
    expect(f.options.providerFor).not.toHaveBeenCalled();
  });

  it("rejects an artifact without ledgers", async () => {
    const f = await fixture();
    vi.mocked(f.client.download).mockResolvedValue();
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      /contains no/,
    );
    expect(f.options.providerFor).not.toHaveBeenCalled();
  });

  it("does not overwrite earlier local recovery results", async () => {
    const f = await fixture();
    mkdirSync(f.directory, { recursive: true });
    writeFileSync(path.join(f.directory, "keep"), "original");
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      /overwrite/,
    );
    expect(readFileSync(path.join(f.directory, "keep"), "utf8")).toBe(
      "original",
    );
    expect(f.client.download).not.toHaveBeenCalled();
  });

  it.each(["{broken", '{"event":"unknown"}', '{"event":"deleted"}', ""])(
    "rejects malformed ledgers before any deletion: %j",
    async (contents) => {
      const f = await fixture();
      const original = f.client.download;
      f.client.download = async (...args) => {
        await original(...args);
        writeFileSync(path.join(path.dirname(f.file), "bad.json"), "ignored");
        const bad = path.join(f.directory, "second", "audit.jsonl");
        mkdirSync(path.dirname(bad));
        writeFileSync(bad, contents);
      };
      await expect(
        sweepActionsRun(f.input, f.client, f.options),
      ).rejects.toThrow();
      expect(f.options.providerFor).not.toHaveBeenCalled();
    },
  );

  it("does not follow symlinked ledger files", async () => {
    const f = await fixture();
    f.client.download = async () => {
      const outside = path.join(path.dirname(f.directory), "outside");
      writeFileSync(outside, "private");
      symlinkSync(outside, path.join(f.directory, "audit.jsonl"));
    };
    await expect(sweepActionsRun(f.input, f.client, f.options)).rejects.toThrow(
      /symbolic links/,
    );
    expect(f.options.providerFor).not.toHaveBeenCalled();
  });
});
