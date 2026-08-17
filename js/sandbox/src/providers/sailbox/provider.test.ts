import { describe, expect, it, vi } from "vitest";
import { App } from "@sailresearch/sdk";
import { decodeSailboxImageRef, encodeSailboxImageRef } from "./image-ref";
import {
  asAmikaCommand,
  configureSailboxAutoSleep,
  configureSailboxAutoSleepOrTerminate,
  mapSailboxSandboxState,
  sailboxAppName,
  sailboxAppOrgId,
} from "./internal/operations";
import {
  deleteSailboxCheckpoint,
  getSailboxCheckpoint,
  waitForSailboxCheckpointActive,
} from "./internal/snapshots";
import { reportSailboxSpend } from "./internal/spend";
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

  it("rejects malformed encoded image specs", () => {
    const encodeUnknown = (value: unknown) =>
      `sail-image:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

    expect(() => decodeSailboxImageRef(encodeUnknown({}))).toThrow(
      "Invalid Sailbox image reference",
    );
    expect(() =>
      decodeSailboxImageRef(
        encodeUnknown({
          base: "debian",
          buildSteps: [{ runCommand: { command: "" } }],
        }),
      ),
    ).toThrow("Invalid Sailbox image reference");
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

  it("loads managed environment before applying command overrides", () => {
    const command = asAmikaCommand("printf '%s' \"$TOKEN:$MANAGED\"", {
      TOKEN: "per call",
    });

    expect(command).toContain("/etc/environment");
    expect(command.indexOf("/etc/environment")).toBeLessThan(
      command.indexOf("TOKEN="),
    );
    expect(command).toContain("TOKEN=");
    expect(command).toContain("per call");
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

  it("terminates a new Sailbox when auto-sleep configuration fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 500 }));
    const terminate = vi.fn(async () => undefined);

    await expect(
      configureSailboxAutoSleepOrTerminate(
        { apiKey: "secret", sailboxApiUrl: "https://boxes.example" },
        { sailboxId: "sb_orphan", terminate },
        15,
      ),
    ).rejects.toThrow("Sailbox auto-sleep update failed");
    expect(terminate).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  it("normalizes provider-reported observed spend", async () => {
    const appListMock = vi.spyOn(App, "list").mockResolvedValue([
      {
        id: "app_123",
        name: "amika-org_123",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      } as App,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        rates: {
          vcpu_second_usd_nanos: 10,
          memory_gib_second_usd_nanos: 20,
          state_disk_gib_second_usd_nanos: 30,
        },
        sailboxes: [
          {
            sailbox_id: "sb_123",
            app_id: "app_123",
            finalized_cost_usd_nanos: 800,
            estimated_active_cost_usd_nanos: 100,
            estimated_total_cost_usd_nanos: 900,
            duration_seconds: 60,
            vcpu_seconds: 4,
            memory_gib_seconds: 5,
            state_disk_gib_seconds: 6,
            active: true,
          },
        ],
      }),
    );

    await expect(
      reportSailboxSpend(
        { apiKey: "secret", sailboxApiUrl: "https://boxes.example/" },
        {
          from: new Date("2026-08-16T12:00:00.000Z"),
          to: new Date("2026-08-16T12:01:00.000Z"),
        },
      ),
    ).resolves.toEqual([
      {
        providerSandboxId: "sb_123",
        orgId: "org_123",
        state: "active",
        durationSeconds: 60,
        vcpuSeconds: 4,
        memoryGibSeconds: 5,
        diskGibSeconds: 6,
        cpuDollars: 40 / 1_000_000_000,
        memoryDollars: 100 / 1_000_000_000,
        diskDollars: 180 / 1_000_000_000,
        amountDollars: 900 / 1_000_000_000,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://boxes.example/sailboxes/spend?from=2026-08-16T12%3A00%3A00.000Z&to=2026-08-16T12%3A01%3A00.000Z",
      { headers: { Authorization: "Bearer secret" } },
    );
    appListMock.mockRestore();
    fetchMock.mockRestore();
  });
});
