import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DaytonaConfig } from "../config";

// Keep the real enums; stub the two APIs the size listing reads.
const { snapshotsApi, organizationsApi } = vi.hoisted(() => ({
  snapshotsApi: { getAllSnapshots: vi.fn() },
  organizationsApi: { listAvailableRegions: vi.fn() },
}));

vi.mock("@daytona/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytona/api-client")>();
  return {
    ...actual,
    Configuration: vi.fn(),
    // Regular functions (not arrows) so they work as constructors with `new`.
    SnapshotsApi: vi.fn(function () {
      return snapshotsApi;
    }),
    OrganizationsApi: vi.fn(function () {
      return organizationsApi;
    }),
  };
});

import { listDaytonaAccountSizes } from "./account";

const config: DaytonaConfig = {
  apiKey: "key",
  apiUrl: "https://daytona.example",
  organizationId: "org-1",
  useVm: true,
};

/** A general, active VM snapshot in region `us`, with `overrides` applied. */
function snapshot(overrides: Record<string, unknown>) {
  return {
    name: "daytona-vm-large",
    general: true,
    state: "active",
    sandboxClass: "linux-vm",
    regionIds: ["us"],
    cpu: 4,
    mem: 8,
    disk: 10,
    ...overrides,
  };
}

/** Serve `items` as one page per entry of `pages`. */
function serveSnapshots(...pages: ReturnType<typeof snapshot>[][]): void {
  snapshotsApi.getAllSnapshots.mockReset();
  pages.forEach((items, i) => {
    snapshotsApi.getAllSnapshots.mockResolvedValueOnce({
      data: { items, total: 0, page: i + 1, totalPages: pages.length },
    });
  });
}

describe("listDaytonaAccountSizes", () => {
  beforeEach(() => {
    organizationsApi.listAvailableRegions
      .mockReset()
      .mockResolvedValue({ data: [{ id: "us" }] });
  });

  it("lists the general VM snapshots the org's regions serve, smallest first, with their names", async () => {
    serveSnapshots([
      snapshot({ name: "daytona-vm-large", cpu: 4, mem: 8, disk: 10 }),
      snapshot({ name: "daytona-vm-medium", cpu: 2, mem: 4, disk: 8 }),
    ]);

    await expect(listDaytonaAccountSizes(config)).resolves.toEqual([
      {
        vcpus: 2,
        memoryGib: 4,
        diskGib: 8,
        image: "daytona-vm-medium",
        imageOwner: "provider",
      },
      {
        vcpus: 4,
        memoryGib: 8,
        diskGib: 10,
        image: "daytona-vm-large",
        imageOwner: "provider",
      },
    ]);
    expect(snapshotsApi.getAllSnapshots).toHaveBeenCalledWith(
      "org-1",
      1,
      100,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(organizationsApi.listAvailableRegions).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("is empty when no region of the org serves the VM snapshots", async () => {
    // Daytona lists its general VM snapshots to every org, but an org whose
    // regions serve none refuses a create from them.
    serveSnapshots([snapshot({ regionIds: [] })]);

    await expect(listDaytonaAccountSizes(config)).resolves.toEqual([]);
  });

  it("skips inactive and other-class snapshots, and those no region serves", async () => {
    serveSnapshots([
      snapshot({ name: "building", state: "building" }),
      snapshot({ name: "container", sandboxClass: "container" }),
      snapshot({ name: "elsewhere", regionIds: ["eu"] }),
    ]);

    await expect(listDaytonaAccountSizes(config)).resolves.toEqual([]);
  });

  it("lists the org's own snapshots too, owned by the account", async () => {
    serveSnapshots([snapshot({ name: "own-vm", general: false })]);

    const sizes = await listDaytonaAccountSizes(config);

    expect(sizes).toEqual([
      expect.objectContaining({ image: "own-vm", imageOwner: "account" }),
    ]);
  });

  it("lists only what the configured target region serves", async () => {
    organizationsApi.listAvailableRegions.mockResolvedValue({
      data: [
        { id: "us", name: "us" },
        { id: "eu-1", name: "eu" },
      ],
    });
    serveSnapshots([
      snapshot({ name: "in-us", regionIds: ["us"] }),
      snapshot({ name: "in-eu", regionIds: ["eu-1"] }),
    ]);

    const byName = await listDaytonaAccountSizes({ ...config, target: "eu" });
    expect(byName.map((s) => s.image)).toEqual(["in-eu"]);

    serveSnapshots([
      snapshot({ name: "in-us", regionIds: ["us"] }),
      snapshot({ name: "in-eu", regionIds: ["eu-1"] }),
    ]);
    const byId = await listDaytonaAccountSizes({ ...config, target: "us" });
    expect(byId.map((s) => s.image)).toEqual(["in-us"]);
  });

  it("lists container snapshots when the config does not use VMs", async () => {
    serveSnapshots([
      snapshot({ name: "daytona-medium", sandboxClass: "container" }),
      snapshot({ name: "daytona-vm-large" }),
    ]);

    const sizes = await listDaytonaAccountSizes({ ...config, useVm: false });

    expect(sizes.map((s) => s.image)).toEqual(["daytona-medium"]);
  });

  it("reads every page of snapshots", async () => {
    serveSnapshots(
      [snapshot({ name: "a", cpu: 2, mem: 4 })],
      [snapshot({ name: "b", cpu: 4, mem: 8 })],
    );

    const sizes = await listDaytonaAccountSizes(config);

    expect(sizes.map((s) => s.image)).toEqual(["a", "b"]);
    expect(snapshotsApi.getAllSnapshots).toHaveBeenCalledTimes(2);
  });
});
