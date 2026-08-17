import { describe, expect, it, vi } from "vitest";
import { decodeSailboxImageRef, encodeSailboxImageRef } from "./image-ref";
import {
  configureSailboxAutoSleep,
  mapSailboxSandboxState,
  sailboxAppName,
  sailboxAppOrgId,
} from "./internal/operations";
import {
  deleteSailboxCheckpoint,
  getSailboxCheckpoint,
  waitForSailboxCheckpointActive,
} from "./internal/snapshots";
import { sailboxSizingForSize } from "./sizing";

describe("Sailbox provider", () => {
  it("round-trips image references and leaves checkpoint ids distinct", () => {
    const image = {
      base: "debian" as const,
      architecture: "amd64" as const,
      buildSteps: [{ runCommand: { command: "echo ready" } }],
    };
    expect(decodeSailboxImageRef(encodeSailboxImageRef(image))).toEqual(image);
    expect(decodeSailboxImageRef("checkpoint_123")).toBeNull();
  });

  it("maps Amika sizes onto valid Sailbox allocations", () => {
    expect(sailboxSizingForSize("xs")).toEqual({
      size: "s",
      vcpus: 1,
      memoryGib: 2,
      diskGib: 8,
    });
    expect(sailboxSizingForSize("m").memoryGib).toBe(8);
    expect(sailboxSizingForSize("l").memoryGib).toBe(12);
    expect(sailboxSizingForSize("xl").memoryGib).toBe(16);
  });

  it("maps lifecycle states without treating sleep as failure", () => {
    expect(mapSailboxSandboxState("running")).toBe("running");
    expect(mapSailboxSandboxState("paused")).toBe("suspended");
    expect(mapSailboxSandboxState("sleeping")).toBe("suspended");
    expect(mapSailboxSandboxState("terminating")).toBe("stopping");
    expect(mapSailboxSandboxState("failed")).toBe("failed");
    expect(mapSailboxSandboxState("future_state")).toBe("unknown");
  });

  it("round-trips org attribution through Sail App names", () => {
    const config = { apiKey: "k", appPrefix: "amika-staging" };
    const name = sailboxAppName(config, "org_123");
    expect(name).toBe("amika-staging-org_123");
    expect(sailboxAppOrgId(config, name)).toBe("org_123");
    expect(sailboxAppOrgId(config, "foreign-org_123")).toBeNull();
  });

  it("uses the database as the checkpoint index and makes delete a no-op", async () => {
    const resolve = vi.fn(async () => "cp_123");
    await expect(
      getSailboxCheckpoint(resolve, "org/sandbox/x"),
    ).resolves.toEqual({
      name: "org/sandbox/x",
      providerSnapshotId: "cp_123",
      state: "active",
    });
    await expect(
      waitForSailboxCheckpointActive(resolve, "org/sandbox/x", "cp_fresh"),
    ).resolves.toMatchObject({ providerSnapshotId: "cp_fresh" });
    await expect(deleteSailboxCheckpoint()).resolves.toBeUndefined();
  });

  it("translates Amika auto-stop minutes into Sail auto-sleep", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const config = {
      apiKey: "secret",
      sailboxApiUrl: "https://boxes.example/",
    };

    await configureSailboxAutoSleep(config, "box/id", 15);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://boxes.example/sailboxes/box%2Fid/auto_sleep",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          automatic: true,
          min_seconds_before_sleep: 900,
        }),
      }),
    );
    await configureSailboxAutoSleep(config, "box", 0);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ automatic: false }),
    );
    fetchMock.mockRestore();
  });
});
