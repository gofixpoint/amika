import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelConfig } from "../config";
import {
  captureVercelSnapshot,
  removeVercelInjectedSecrets,
} from "./snapshot-capture";

// --- SDK mocks --------------------------------------------------------------
const sandboxSnapshot = vi.fn(); // sandbox.snapshot({ expiration })
const getVercelSandbox = vi.fn(); // ./client getVercelSandbox

vi.mock("./client", () => ({
  getVercelSandbox: (...args: unknown[]) => getVercelSandbox(...args),
}));

// Fake `VercelAdapter` so the Vercel-specific resume-context removal
// (`execChecked` → `adapter.exec`) is observable without a live sandbox.
const adapterExec = vi.fn();
vi.mock("./adapter", () => ({
  VercelAdapter: class {
    exec = (...args: unknown[]) => adapterExec(...args);
    downloadFile = () => Promise.resolve(null);
    uploadFile = () => Promise.resolve();
  },
}));

const config: VercelConfig = {
  apiKey: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
};

/** A fake `@vercel/sandbox` `Snapshot` with just the getters we read. */
function fakeSnapshot(overrides: {
  snapshotId?: string;
  status?: string;
  sizeBytes?: number;
}) {
  return {
    snapshotId: overrides.snapshotId ?? "snap_default",
    status: overrides.status ?? "created",
    sizeBytes: overrides.sizeBytes ?? 1024,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  sandboxSnapshot.mockReset();
  getVercelSandbox.mockReset();
  adapterExec.mockReset();
  adapterExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("removeVercelInjectedSecrets", () => {
  it("removes the resume context with sudo over a bare resume", async () => {
    getVercelSandbox.mockResolvedValue({});

    await removeVercelInjectedSecrets(config, "sbx_2");

    // The Vercel-only resume context (holds the OpenCode server password) is
    // removed with sudo; the Amika scrub above in core doesn't cover it.
    expect(adapterExec).toHaveBeenCalledWith(
      expect.stringContaining("vercel-resume.json"),
      { sudo: true },
    );
    expect(adapterExec).toHaveBeenCalledWith(expect.stringContaining("rm -f"), {
      sudo: true,
    });
    // Bare resume: `resume: true` with NO onResume callback — the
    // service-restart callback reads the very file being removed and would
    // relaunch OpenCode with the password mid-scrub.
    expect(getVercelSandbox).toHaveBeenCalledWith(config, "sbx_2", {
      resume: true,
    });
  });
});

describe("captureVercelSnapshot", () => {
  it("snapshots over a bare resume and returns the bootable id", async () => {
    sandboxSnapshot.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_captured" }),
    );
    getVercelSandbox.mockResolvedValue({ snapshot: sandboxSnapshot });

    const result = await captureVercelSnapshot(config, "sbx_2");

    expect(sandboxSnapshot).toHaveBeenCalledWith({ expiration: 0 });
    expect(getVercelSandbox).toHaveBeenCalledWith(config, "sbx_2", {
      resume: true,
    });
    expect(result.providerSnapshotId).toBe("snap_captured");
  });
});
