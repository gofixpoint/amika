import { SANDBOX_SIZE_SPECS } from "../../constants";
import type { SandboxSize } from "../../enums";

export interface SailboxSizing {
  size: "s" | "m";
  vcpus: number;
  memoryGib: number;
  diskGib: number;
}

/** Map Amika's four sizes onto valid Sailbox size/memory/disk combinations. */
export function sailboxSizingForSize(size: SandboxSize): SailboxSizing {
  const requested = SANDBOX_SIZE_SPECS[size];
  if (size === "xs") {
    return { size: "s", vcpus: 1, memoryGib: 2, diskGib: 8 };
  }
  return {
    size: "m",
    vcpus: 4,
    memoryGib: requested.memoryGb,
    diskGib: 32,
  };
}
