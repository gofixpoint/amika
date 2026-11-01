import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import { setup, teardown } from "./global-setup";

const RUN_ID = "fixed-run";
const CREATED = JSON.stringify({
  event: "created",
  kind: "sandbox",
  provider: "acme",
  id: "sb-1",
  name: "n",
  test: "t",
  at: "2026-11-01T12:00:00Z",
});
const DELETED = JSON.stringify({
  event: "deleted",
  kind: "sandbox",
  id: "sb-1",
  verified: true,
  at: "2026-11-01T12:01:00Z",
});

const fakeProject = { provide: () => {} } as unknown as TestProject;
let root = "";

/** Write the run's ledger and point the global setup at it. */
function runWithLedger(contents: string): void {
  mkdirSync(path.join(root, RUN_ID), { recursive: true });
  writeFileSync(path.join(root, RUN_ID, "audit.jsonl"), contents);
  setup(fakeProject);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "contract-runs-"));
  vi.stubEnv("TEST_SANDBOX_CONTRACT_RUNS_DIR", root);
  vi.stubEnv("TEST_SANDBOX_CONTRACT_RUN_ID", RUN_ID);
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("contract global teardown", () => {
  it("passes a run whose resources were all deleted", () => {
    runWithLedger(`${CREATED}\n${DELETED}\n`);
    teardown();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails a run with a leak", () => {
    runWithLedger(`${CREATED}\n`);
    expect(() => teardown()).toThrow(/1 resource\(s\) leaked/);
    expect(process.exitCode).toBe(1);
  });

  it("fails closed on a truncated ledger", () => {
    runWithLedger(`${CREATED}\n{"event":"del`);
    expect(() => teardown()).toThrow(/not valid JSON/);
    expect(process.exitCode).toBe(1);
  });

  it("fails the run when the step summary cannot be written", () => {
    runWithLedger(`${CREATED}\n${DELETED}\n`);
    vi.stubEnv(
      "GITHUB_STEP_SUMMARY",
      path.join(root, "missing-dir", "summary.md"),
    );
    expect(() => teardown()).toThrow(/GITHUB_STEP_SUMMARY/);
    expect(process.exitCode).toBe(1);
  });

  it("marks a leak failed even when the step summary also fails", () => {
    runWithLedger(`${CREATED}\n`);
    vi.stubEnv(
      "GITHUB_STEP_SUMMARY",
      path.join(root, "missing-dir", "summary.md"),
    );
    expect(() => teardown()).toThrow();
    expect(process.exitCode).toBe(1);
  });
});
