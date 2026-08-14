/**
 * Translate a canonical sandbox size (xs/m/l/xl, see {@link SANDBOX_SIZE_SPECS})
 * into the Vercel `resources` allocation `Sandbox.create` accepts.
 *
 * Unlike Daytona (size baked into the image) and Freestyle (size baked into a
 * per-size snapshot), Vercel takes the size at create time via `resources`, and
 * couples memory to vCPU count: every vCPU comes with a fixed 2 GB of memory and
 * the only knob is the vCPU count, which must be `1` or an even number from 2 to
 * 32 (the Enterprise ceiling; Hobby caps at 4 and Pro at 8). So we pick the
 * smallest valid vCPU count that satisfies BOTH the canonical size's vCPU and
 * its memory request — otherwise a larger size would silently boot with Vercel's
 * default 2 vCPUs / 4 GB. Mapping memory through the 2 GB-per-vCPU coupling
 * reproduces the advertised memory (m → 8 GB, l → 12 GB, xl → 16 GB) while the
 * vCPU count rises to match. An over-plan request (e.g. xl → 8 vCPUs on Hobby)
 * is rejected loudly by `create` rather than silently downsized.
 */
import { SANDBOX_SIZE_SPECS } from "../../constants";
import type { SandboxSize } from "../../enums";

/** Vercel allocates a fixed 2 GB of memory per vCPU; it is not configurable. */
const VERCEL_MEMORY_GB_PER_VCPU = 2;

/** Largest vCPU count Vercel offers (Enterprise plan ceiling). */
const VERCEL_MAX_VCPUS = 32;

/**
 * Every Vercel sandbox gets a fixed 32 GB of ephemeral NVMe storage regardless
 * of the chosen vCPU/memory size, so disk does not vary by size.
 */
const VERCEL_DISK_GB = 32;

export interface VercelSizing {
  /** vCPU count (`1` or an even number, 2–32). */
  vcpus: number;
  /** Memory in GB (derived: 2 GB per vCPU). */
  memoryGb: number;
  /** Ephemeral disk in GB (fixed by the platform). */
  diskGb: number;
}

/**
 * The vCPU count to request for `size`: the smallest valid Vercel value (`1`, or
 * an even number up to {@link VERCEL_MAX_VCPUS}) that provides at least the
 * size's vCPUs and — via the 2 GB-per-vCPU coupling — at least its memory.
 */
export function vercelVcpusForSize(size: SandboxSize): number {
  const spec = SANDBOX_SIZE_SPECS[size];
  const needed = Math.max(
    spec.vcpus,
    Math.ceil(spec.memoryGb / VERCEL_MEMORY_GB_PER_VCPU),
  );
  if (needed <= 1) {
    return 1;
  }
  const even = needed % 2 === 0 ? needed : needed + 1;
  return Math.min(even, VERCEL_MAX_VCPUS);
}

/** Effective Vercel dimensions for `size` (for both create and display). */
export function vercelSizingForSize(size: SandboxSize): VercelSizing {
  const vcpus = vercelVcpusForSize(size);
  return {
    vcpus,
    memoryGb: vcpus * VERCEL_MEMORY_GB_PER_VCPU,
    diskGb: VERCEL_DISK_GB,
  };
}

/**
 * Effective Vercel dimensions for an already-provisioned sandbox that reports
 * `vcpus`. `Sandbox.list()` exposes only the vCPU count, so memory and disk are
 * recovered from the same fixed 2 GB-per-vCPU / 32 GB-disk coupling
 * {@link vercelSizingForSize} applies at create time. Used by the spend meter to
 * size a running sandbox from its live vCPU count.
 */
export function vercelSizingForVcpus(vcpus: number): VercelSizing {
  return {
    vcpus,
    memoryGb: vcpus * VERCEL_MEMORY_GB_PER_VCPU,
    diskGb: VERCEL_DISK_GB,
  };
}
