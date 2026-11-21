import { describe, expect, it } from "vitest";
import { gcpTarget } from "./client";
import { gcpName } from "./names";
import {
  customMachineTypeSize,
  GCP_STOCK_IMAGE,
  machineTypeFor,
  mapGcpSandboxState,
  sourceImageFor,
} from "./operations";
import { mapGcpImageStatus } from "./snapshot-operations";
import { TEST_CONFIG } from "./test-key";

const target = gcpTarget(TEST_CONFIG);

describe("machineTypeFor", () => {
  it("makes an E2 custom type", () => {
    expect(
      machineTypeFor("us-central1-a", { vcpus: 4, memoryGib: 8, diskGib: 20 }),
    ).toBe("zones/us-central1-a/machineTypes/e2-custom-4-8192");
    expect(machineTypeFor("z", { vcpus: 16, memoryGib: 24, diskGib: 40 })).toBe(
      "zones/z/machineTypes/e2-custom-16-24576",
    );
  });

  it("refuses sizes E2 cannot run", () => {
    expect(() =>
      machineTypeFor("z", { vcpus: 1, memoryGib: 1, diskGib: 10 }),
    ).toThrow(/even number of vCPUs/);
    expect(() =>
      machineTypeFor("z", { vcpus: 2, memoryGib: 32, diskGib: 10 }),
    ).toThrow(/per vCPU/);
  });
});

describe("customMachineTypeSize", () => {
  it("reads vCPUs and memory from a custom type URL", () => {
    expect(
      customMachineTypeSize(
        "https://compute.googleapis.com/compute/v1/projects/p/zones/z/machineTypes/e2-custom-4-8192",
      ),
    ).toEqual({ vcpus: 4, memoryGib: 8 });
    expect(
      customMachineTypeSize("zones/z/machineTypes/custom-2-5120-ext"),
    ).toEqual({ vcpus: 2, memoryGib: 5 });
    expect(customMachineTypeSize("zones/z/machineTypes/e2-standard-4")).toBe(
      null,
    );
  });
});

describe("sourceImageFor", () => {
  it("takes full paths, project images, and image names", () => {
    expect(sourceImageFor(target, "")).toBe(GCP_STOCK_IMAGE);
    expect(sourceImageFor(target, GCP_STOCK_IMAGE)).toBe(GCP_STOCK_IMAGE);
    expect(sourceImageFor(target, "global/images/base")).toBe(
      "projects/acme-proj/global/images/base",
    );
    expect(sourceImageFor(target, "Org/Snap_1")).toBe(
      `projects/acme-proj/global/images/${gcpName("Org/Snap_1")}`,
    );
  });
});

describe("gcpName", () => {
  it("keeps a valid name and maps any other to a valid one", () => {
    expect(gcpName("rig-1")).toBe("rig-1");
    for (const name of [
      "My Rig--sbx_123",
      "1-starts-with-digit",
      "x".repeat(80),
      "///",
    ]) {
      const mapped = gcpName(name);
      expect(mapped).toMatch(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/);
      expect(gcpName(name)).toBe(mapped);
    }
    expect(gcpName("A")).not.toBe(gcpName("a-"));
  });
});

describe("state mapping", () => {
  it.each([
    ["PROVISIONING", "starting"],
    ["STAGING", "starting"],
    ["RUNNING", "running"],
    ["STOPPING", "stopping"],
    ["TERMINATED", "stopped"],
    ["SUSPENDED", "suspended"],
    ["REPAIRING", "unknown"],
  ])("maps VM status %s to %s", (raw, status) => {
    expect(mapGcpSandboxState(raw)).toBe(status);
  });

  it("maps image statuses", () => {
    expect(mapGcpImageStatus("READY")).toBe("active");
    expect(mapGcpImageStatus("PENDING")).toBe("building");
    expect(mapGcpImageStatus("FAILED")).toBe("build_failed");
  });
});
