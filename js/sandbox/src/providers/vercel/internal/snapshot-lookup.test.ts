import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelConfig } from "../config";
import type { SnapshotIdResolver } from "../../provider";
import {
  deleteVercelSnapshotByName,
  getVercelSnapshotByName,
  mapVercelSnapshotStatus,
  waitForVercelSnapshotActive,
} from "./snapshot-lookup";

// --- SDK mocks --------------------------------------------------------------
const snapshotGet = vi.fn(); // Snapshot.get({ snapshotId })
const snapshotDelete = vi.fn(); // Snapshot.delete()

/**
 * Stand-in for the SDK's `APIError` (extends `Error`, carries `response`). The
 * lookup only treats a 404 as "absent"; everything else must propagate, so
 * tests raise this with a specific status to exercise both paths. Must be the
 * class the module imports, so it is the `@vercel/sandbox` mock's `APIError`.
 * Defined via `vi.hoisted` so it exists when the hoisted mock factory runs.
 */
const { FakeAPIError } = vi.hoisted(() => {
  class FakeAPIError extends Error {
    response: { status: number };
    constructor(status: number) {
      super(`api error ${status}`);
      this.response = { status };
    }
  }
  return { FakeAPIError };
});

vi.mock("@vercel/sandbox", () => ({
  Snapshot: { get: (...args: unknown[]) => snapshotGet(...args) },
  APIError: FakeAPIError,
}));

vi.mock("./client", () => ({
  vercelCredentials: (config: VercelConfig) => ({
    token: config.apiKey,
    teamId: config.teamId,
    projectId: config.projectId,
  }),
}));

// The name→id resolution is a control-plane concern injected as a port; the
// lookup module itself is store-free, so the tests drive a plain stub resolver
// rather than mocking a snapshot store. (The resolver's own logic —
// org-scoping the name, reading `provider_snapshot_id` — is tested in
// `@/lib/sandbox-snapshots/snapshot-id-resolver.test.ts`.)
const resolveSnapshotId = vi.fn<SnapshotIdResolver>();

const config: VercelConfig = {
  apiKey: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
};
const ORG = "org_abc123";
const NAME = `${ORG}/sandbox/my-snap`;

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
    delete: snapshotDelete,
  };
}

beforeEach(() => {
  snapshotGet.mockReset();
  snapshotDelete.mockReset();
  resolveSnapshotId.mockReset();
});

describe("mapVercelSnapshotStatus", () => {
  it.each([
    ["created", "active"],
    ["failed", "build_failed"],
    ["deleted", "error"],
  ])("maps Vercel status %s to %s", (status, expected) => {
    expect(mapVercelSnapshotStatus(status)).toBe(expected);
  });

  it("passes an unknown status through unchanged", () => {
    expect(mapVercelSnapshotStatus("weird")).toBe("weird");
    expect(mapVercelSnapshotStatus(undefined)).toBeUndefined();
  });
});

describe("getVercelSnapshotByName", () => {
  it("returns null and skips the SDK when the resolver yields no id", async () => {
    resolveSnapshotId.mockResolvedValue(null);
    expect(
      await getVercelSnapshotByName(resolveSnapshotId, config, NAME),
    ).toBeNull();
    expect(snapshotGet).not.toHaveBeenCalled();
  });

  it("resolves the name→id via the resolver then gets by id", async () => {
    resolveSnapshotId.mockResolvedValue("snap_xyz");
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_xyz", status: "created" }),
    );

    const result = await getVercelSnapshotByName(
      resolveSnapshotId,
      config,
      NAME,
    );

    expect(resolveSnapshotId).toHaveBeenCalledWith(NAME);
    expect(snapshotGet).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: "snap_xyz" }),
    );
    expect(result).toMatchObject({
      name: NAME,
      providerSnapshotId: "snap_xyz",
      state: "active",
    });
  });

  it("returns null when the provider no longer has the snapshot (404)", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockRejectedValue(new FakeAPIError(404));
    expect(
      await getVercelSnapshotByName(resolveSnapshotId, config, NAME),
    ).toBeNull();
  });

  it("propagates a transient (non-404) provider error, not treating it as absent", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockRejectedValue(new FakeAPIError(500));
    // A 5xx must NOT read as "snapshot gone" — that would 404 an active
    // snapshot; the error propagates so the caller can retry.
    await expect(
      getVercelSnapshotByName(resolveSnapshotId, config, NAME),
    ).rejects.toBeInstanceOf(FakeAPIError);
  });
});

describe("deleteVercelSnapshotByName", () => {
  it("is a no-op when the resolver yields no id for the name", async () => {
    resolveSnapshotId.mockResolvedValue(null);
    await deleteVercelSnapshotByName(resolveSnapshotId, config, NAME);
    expect(snapshotGet).not.toHaveBeenCalled();
    expect(snapshotDelete).not.toHaveBeenCalled();
  });

  it("deletes the resolved snapshot via the id-keyed SDK", async () => {
    resolveSnapshotId.mockResolvedValue("snap_del");
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_del", status: "created" }),
    );
    await deleteVercelSnapshotByName(resolveSnapshotId, config, NAME);
    expect(snapshotDelete).toHaveBeenCalledTimes(1);
  });

  it("tolerates a snapshot already gone from the provider (404)", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockRejectedValue(new FakeAPIError(404));
    await expect(
      deleteVercelSnapshotByName(resolveSnapshotId, config, NAME),
    ).resolves.toBeUndefined();
    expect(snapshotDelete).not.toHaveBeenCalled();
  });

  it("propagates a transient (non-404) error instead of orphaning the snapshot", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockRejectedValue(new FakeAPIError(503));
    // If a 5xx read as "gone", the service would drop the DB row while the
    // provider snapshot lived on (orphan). The error must propagate instead.
    await expect(
      deleteVercelSnapshotByName(resolveSnapshotId, config, NAME),
    ).rejects.toBeInstanceOf(FakeAPIError);
    expect(snapshotDelete).not.toHaveBeenCalled();
  });

  it("uses a known snapshot id without consulting the resolver", async () => {
    // A fresh capture's bound delete() runs before the control plane records
    // the name↔id mapping, so the resolver would say "nothing to delete".
    resolveSnapshotId.mockResolvedValue(null);
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_known", status: "created" }),
    );
    await deleteVercelSnapshotByName(
      resolveSnapshotId,
      config,
      NAME,
      "snap_known",
    );
    expect(resolveSnapshotId).not.toHaveBeenCalled();
    expect(snapshotDelete).toHaveBeenCalledTimes(1);
  });
});

describe("waitForVercelSnapshotActive", () => {
  it("returns once the snapshot reads back as created", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_row", status: "created" }),
    );
    const result = await waitForVercelSnapshotActive(
      resolveSnapshotId,
      config,
      NAME,
    );
    expect(result.state).toBe("active");
    expect(result.providerSnapshotId).toBe("snap_row");
  });

  it("throws when the snapshot enters a terminal status", async () => {
    resolveSnapshotId.mockResolvedValue("snap_row");
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_row", status: "failed" }),
    );
    await expect(
      waitForVercelSnapshotActive(resolveSnapshotId, config, NAME),
    ).rejects.toThrow(/terminal status "failed"/);
  });

  it("throws on timeout when no bootable id is ever recorded", async () => {
    resolveSnapshotId.mockResolvedValue(null);
    // Zero timeout: the first pass past the deadline throws.
    await expect(
      waitForVercelSnapshotActive(resolveSnapshotId, config, NAME, null, 0),
    ).rejects.toThrow(/did not become ready/);
    expect(snapshotGet).not.toHaveBeenCalled();
  });

  it("uses a known snapshot id without consulting the resolver", async () => {
    // A fresh capture's bound waitForActive() runs before the control plane
    // records the name↔id mapping; the known id must short-circuit the
    // resolver or the wait would poll to timeout.
    resolveSnapshotId.mockResolvedValue(null);
    snapshotGet.mockResolvedValue(
      fakeSnapshot({ snapshotId: "snap_known", status: "created" }),
    );
    const result = await waitForVercelSnapshotActive(
      resolveSnapshotId,
      config,
      NAME,
      "snap_known",
    );
    expect(resolveSnapshotId).not.toHaveBeenCalled();
    expect(result.providerSnapshotId).toBe("snap_known");
    expect(result.state).toBe("active");
  });
});
