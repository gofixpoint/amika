/**
 * Translate a canonical sandbox size (xs/m/l/xl, see {@link SANDBOX_SIZE_SPECS})
 * into the `{ cpu, memory, storage }` arguments Freestyle's `vm.resize` accepts.
 *
 * Daytona encodes size in the chosen image; Freestyle has no image-per-size
 * concept, so the size is baked into a per-size snapshot at build time:
 * `bin/freestyle-build-snapshots` resizes a VM to these dimensions before
 * snapshotting it as `amika-<preset>-<size>`, and the create flow clones that
 * snapshot with no runtime resize. This function defines the dimensions for
 * that build step and for the size picker's display; Freestyle enforces two
 * constraints the canonical specs don't honor, which it reconciles:
 *
 *   - vCPU and memory (MiB) must be powers of two. Our `vcpus` are already
 *     powers of two (1/2/2/4), but `memoryGb` is not for every size — L is
 *     12 GB. We round memory UP to the next power-of-two GiB so a size is never
 *     under-provisioned (L's 12 GB → 16 GB).
 *   - The rootfs can only grow, never shrink, below the VM's base size. The
 *     build script passes `storage` as the desired target and tolerates a
 *     `RESIZE_VM_ROOTFS_SHRINK_NOT_SUPPORTED` rejection, keeping the base.
 */
import { SANDBOX_SIZE_SPECS } from "../../constants";
import type { SandboxSize } from "../../enums";

export interface FreestyleSizing {
  /** vCPU count (power of two). */
  cpu: number;
  /** Memory in GiB (power of two). */
  memory: number;
  /** Root filesystem target in GB (grow-only; smaller-than-base is a no-op). */
  storage: number;
}

/** Smallest power of two >= n (n is a small positive integer here). */
function roundUpToPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function freestyleSizingForSize(size: SandboxSize): FreestyleSizing {
  const spec = SANDBOX_SIZE_SPECS[size];
  return {
    cpu: roundUpToPowerOfTwo(spec.vcpus),
    memory: roundUpToPowerOfTwo(spec.memoryGb),
    storage: spec.diskGb,
  };
}
