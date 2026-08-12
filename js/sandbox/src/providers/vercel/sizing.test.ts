import { describe, expect, it } from "vitest";
import { vercelSizingForSize, vercelVcpusForSize } from "./sizing";

describe("vercelVcpusForSize", () => {
  it("picks the smallest valid vCPU count covering both vCPU and memory", () => {
    // Memory is the binding constraint at 2 GB/vCPU: m wants 8 GB → 4 vCPUs,
    // l wants 12 GB → 6 vCPUs, xl wants 16 GB → 8 vCPUs. xs (1 GB) → the
    // minimum of 1 vCPU.
    expect(vercelVcpusForSize("xs")).toBe(1);
    expect(vercelVcpusForSize("m")).toBe(4);
    expect(vercelVcpusForSize("l")).toBe(6);
    expect(vercelVcpusForSize("xl")).toBe(8);
  });
});

describe("vercelSizingForSize", () => {
  it("derives memory at 2 GB/vCPU and reports the fixed 32 GB disk", () => {
    expect(vercelSizingForSize("xs")).toEqual({
      vcpus: 1,
      memoryGb: 2,
      diskGb: 32,
    });
    expect(vercelSizingForSize("m")).toEqual({
      vcpus: 4,
      memoryGb: 8,
      diskGb: 32,
    });
    expect(vercelSizingForSize("l")).toEqual({
      vcpus: 6,
      memoryGb: 12,
      diskGb: 32,
    });
    expect(vercelSizingForSize("xl")).toEqual({
      vcpus: 8,
      memoryGb: 16,
      diskGb: 32,
    });
  });
});
