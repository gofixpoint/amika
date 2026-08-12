import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FreestyleConfig } from "../config";
import {
  captureFreestyleSandboxSnapshot,
  deleteFreestyleSnapshotByName,
  getFreestyleSnapshotByName,
  resolveFreestyleSnapshotRef,
  waitForFreestyleSnapshotActive,
} from "./snapshot-operations";

const listSnapshots = vi.fn(); // client.vms.snapshots.list
const listVms = vi.fn(); // client.vms.list (drives getFreestyleSandboxState)
const vmSnapshot = vi.fn(); // vm.snapshot
const vmStop = vi.fn(); // vm.stop
const rootExec = vi.fn(); // rootVm.exec (sudo cmds, getent, ls verify)
const userExec = vi.fn(); // amika-scoped exec (credential rm)
const readTextFile = vi.fn(); // fs.readTextFile (/etc/environment)
const fakeUserVm = {
  exec: userExec,
  fs: { readTextFile, writeTextFile: vi.fn(), writeFile: vi.fn() },
};
const fakeVm = {
  snapshot: vmSnapshot,
  stop: vmStop,
  exec: rootExec,
  user: vi.fn(() => fakeUserVm),
  fs: { readTextFile, writeTextFile: vi.fn(), writeFile: vi.fn() },
};
const vmRef = vi.fn(() => fakeVm);
const clientFetch = vi.fn();

vi.mock("./client", () => ({
  createFreestyleClient: () => ({
    vms: { snapshots: { list: listSnapshots }, ref: vmRef, list: listVms },
    fetch: clientFetch,
  }),
  FREESTYLE_CONTROL_PLANE_TIMEOUT_MS: 120000,
}));

const config: FreestyleConfig = { apiKey: "test-key" };
const NAME = "org_abc123/sandbox/my-snap";

// The scrub targets the control plane computes and passes in. The mechanism
// removes exactly these paths and echoes the env-var names into the disclosure.

function snap(overrides: Record<string, unknown>) {
  return {
    snapshotId: "sc-default",
    name: NAME,
    createdAt: "2026-06-01T00:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  listSnapshots.mockReset();
  listVms.mockReset();
  vmSnapshot.mockReset();
  vmStop.mockReset();
  rootExec.mockReset();
  userExec.mockReset();
  readTextFile.mockReset();
  vmRef.mockClear();
  clientFetch.mockReset();
});

describe("getFreestyleSnapshotByName", () => {
  it("returns null when no snapshot carries the name", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", name: "someone-elses" })],
    });
    expect(await getFreestyleSnapshotByName(config, NAME)).toBeNull();
  });

  it("ignores deleted snapshots", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", deleted: true, state: "ready" })],
    });
    expect(await getFreestyleSnapshotByName(config, NAME)).toBeNull();
  });

  it.each([
    ["ready", "active"],
    ["building", "building"],
    ["failed", "build_failed"],
    ["cancelled", "build_failed"],
    ["lost", "error"],
  ])("maps Freestyle state %s to %s", async (freestyleState, expected) => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", state: freestyleState })],
    });
    const result = await getFreestyleSnapshotByName(config, NAME);
    expect(result).toMatchObject({ name: NAME, state: expected });
  });

  it("surfaces the bootable snapshot id (for backfill/boot)", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-99", state: "ready" })],
    });
    const result = await getFreestyleSnapshotByName(config, NAME);
    expect(result?.providerSnapshotId).toBe("sc-99");
  });

  it("prefers a ready snapshot over a building one with the same name", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [
        snap({
          snapshotId: "sc-building",
          state: "building",
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
        snap({
          snapshotId: "sc-ready",
          state: "ready",
          createdAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
    });
    const result = await getFreestyleSnapshotByName(config, NAME);
    expect(result?.state).toBe("active");
  });
});

describe("resolveFreestyleSnapshotRef", () => {
  it("resolves a snapshot name to its bootable id", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-77", state: "ready" })],
    });
    expect(await resolveFreestyleSnapshotRef(config, NAME)).toBe("sc-77");
  });

  it("returns the ref unchanged when no snapshot carries the name", async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });
    expect(await resolveFreestyleSnapshotRef(config, "sc-already-an-id")).toBe(
      "sc-already-an-id",
    );
  });
});

describe("deleteFreestyleSnapshotByName", () => {
  it("deletes every non-deleted snapshot carrying the name via the DELETE route", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [
        snap({ snapshotId: "sc-1", state: "ready" }),
        snap({ snapshotId: "sc-2", deleted: true }),
        snap({ snapshotId: "sc-3", name: "other" }),
      ],
    });
    clientFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

    await deleteFreestyleSnapshotByName(config, NAME);

    expect(clientFetch).toHaveBeenCalledTimes(1);
    expect(clientFetch).toHaveBeenCalledWith("/v1/vms/snapshots/sc-1", {
      method: "DELETE",
    });
  });

  it("is a no-op when no snapshot carries the name", async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });
    await deleteFreestyleSnapshotByName(config, NAME);
    expect(clientFetch).not.toHaveBeenCalled();
  });

  it("tolerates a 404 from the delete route (already gone)", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", state: "ready" })],
    });
    clientFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    await expect(
      deleteFreestyleSnapshotByName(config, NAME),
    ).resolves.toBeUndefined();
  });

  it("throws on a non-404 delete failure", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", state: "ready" })],
    });
    clientFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    await expect(deleteFreestyleSnapshotByName(config, NAME)).rejects.toThrow(
      /Failed to delete/,
    );
  });
});

describe("captureFreestyleSandboxSnapshot", () => {
  it("snapshots the referenced VM and returns the bootable id", async () => {
    vmSnapshot.mockResolvedValue({ snapshotId: "sc-new", sourceVmId: "vm_1" });
    const result = await captureFreestyleSandboxSnapshot(config, "vm_1", NAME);
    expect(vmRef).toHaveBeenCalledWith({ vmId: "vm_1" });
    // Captured as `persistent` so the platform never evicts a user's saved
    // snapshot (the default `sticky` tier is best-effort and can be reclaimed).
    expect(vmSnapshot).toHaveBeenCalledWith({
      name: NAME,
      persistence: { type: "persistent" },
    });
    expect(result).toEqual({ providerSnapshotId: "sc-new" });
  });

  it("captures a `sticky` snapshot when the config opts into staging", async () => {
    // Staging (FREESTYLE_STAGING_SNAPSHOTS) carries `snapshotPersistence:
    // "sticky"` on the config so throwaway staging snapshots stay on the
    // evictable cache tier instead of accumulating permanent storage.
    vmSnapshot.mockResolvedValue({ snapshotId: "sc-new", sourceVmId: "vm_1" });
    await captureFreestyleSandboxSnapshot(
      { ...config, snapshotPersistence: "sticky" },
      "vm_1",
      NAME,
    );
    expect(vmSnapshot).toHaveBeenCalledWith({
      name: NAME,
      persistence: { type: "sticky" },
    });
  });
});

describe("waitForFreestyleSnapshotActive", () => {
  it("returns immediately once the snapshot is ready", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", state: "ready" })],
    });
    const result = await waitForFreestyleSnapshotActive(config, NAME);
    expect(result.state).toBe("active");
  });

  it("throws when the snapshot enters a terminal state", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [snap({ snapshotId: "sc-1", state: "failed" })],
    });
    await expect(waitForFreestyleSnapshotActive(config, NAME)).rejects.toThrow(
      /terminal state "failed"/,
    );
  });
});

describe("captureFreestyleSandboxSnapshot failure attribution", () => {
  it("never stops the VM (a stopped-VM snapshot 500s on Freestyle)", async () => {
    vmSnapshot.mockResolvedValue({ snapshotId: "sc-new" });
    await captureFreestyleSandboxSnapshot(config, "vm_1", NAME);
    expect(vmStop).not.toHaveBeenCalled();
  });

  it("attributes a snapshot failure to the VM state and preserves the cause", async () => {
    listVms.mockResolvedValue({ vms: [{ id: "vm_1", state: "running" }] });
    const providerError = new Error("INTERNAL_ERROR: Internal server");
    vmSnapshot.mockRejectedValue(providerError);

    // The wrapper turns the opaque provider error into one naming the failing
    // step and the VM's state at failure...
    const err = await captureFreestyleSandboxSnapshot(
      config,
      "vm_1",
      NAME,
    ).then(
      () => {
        throw new Error("expected captureFreestyleSandboxSnapshot to reject");
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(
      /"snapshot" step.*VM state: "running".*INTERNAL_ERROR/,
    );
    // ...and preserves the original provider error as `cause` for debugging.
    expect(err.cause).toBe(providerError);
  });
});
