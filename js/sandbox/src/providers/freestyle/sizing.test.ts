import { describe, expect, it } from "vitest";
import { freestyleSizingForSize } from "./sizing";

describe("freestyleSizingForSize", () => {
  it("maps each size to power-of-two CPU/memory and a storage target", () => {
    expect(freestyleSizingForSize("xs")).toEqual({
      cpu: 1,
      memory: 1,
      storage: 3,
    });
    expect(freestyleSizingForSize("m")).toEqual({
      cpu: 2,
      memory: 8,
      storage: 10,
    });
    // L's canonical 12 GB is rounded up to the next power of two.
    expect(freestyleSizingForSize("l")).toEqual({
      cpu: 2,
      memory: 16,
      storage: 24,
    });
    expect(freestyleSizingForSize("xl")).toEqual({
      cpu: 4,
      memory: 16,
      storage: 32,
    });
  });
});
