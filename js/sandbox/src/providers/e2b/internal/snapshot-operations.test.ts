import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("e2b", () => ({ Sandbox: sdk }));

import {
  captureE2bSnapshot,
  getE2bSnapshotByName,
} from "./snapshot-operations";

const CONFIG = { apiKey: "e2b_test" };
const LOGICAL_NAME = "org_123/sandbox/repo.snapshot";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E2B snapshot names", () => {
  it("captures canonical Amika names through a deterministic E2B-safe alias", async () => {
    sdk.createSnapshot.mockResolvedValue({ snapshotId: "snap_1" });

    await expect(
      captureE2bSnapshot(CONFIG, "sbx_1", LOGICAL_NAME),
    ).resolves.toEqual({ providerSnapshotId: "snap_1" });

    const opts = sdk.createSnapshot.mock.calls[0]![1];
    expect(opts).toMatchObject({ apiKey: "e2b_test" });
    expect(opts.name).toMatch(/^[a-z0-9_-]+$/);
    expect(opts.name).not.toContain("/");
    expect(opts.name.length).toBeLessThanOrEqual(63);
  });

  it("matches the E2B-safe alias inside a team-namespaced response", async () => {
    sdk.listSnapshots.mockImplementation((opts: { name: string }) => {
      const pages = [
        [
          {
            snapshotId: "snap_1",
            names: [`team-slug/${opts.name}:default`],
          },
        ],
      ];
      return {
        get hasNext() {
          return pages.length > 0;
        },
        nextItems: async () => pages.shift(),
      };
    });

    await expect(getE2bSnapshotByName(CONFIG, LOGICAL_NAME)).resolves.toEqual({
      name: LOGICAL_NAME,
      providerSnapshotId: "snap_1",
      state: "active",
    });
    expect(sdk.listSnapshots.mock.calls[0]![0].name).toMatch(/^[a-z0-9_-]+$/);
  });
});
