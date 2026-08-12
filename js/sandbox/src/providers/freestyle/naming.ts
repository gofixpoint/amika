/**
 * Org-scoped naming for Freestyle VMs.
 *
 * Daytona stamps each sandbox with `amika-org-id` / `amika-user-id` labels so
 * the owning org is recorded on the provider resource (see `create.ts` and the
 * `${orgId}/sandbox/...` snapshot scheme in `daytona/snapshot-operations.ts`).
 * Freestyle's `vms.create` has no label or metadata facet — only a freeform
 * `name` — so we fold the org id into the VM name instead, using the same
 * `${orgId}/...` convention. This keeps every Freestyle VM attributable to an
 * org in `vms.get` and the dashboard, mirroring Daytona's ownership stamp.
 *
 * The stored `org_id` remains the security boundary; this name is the
 * provider-side stamp, not the access-control gate.
 */
import type { SandboxPreset, SandboxSize } from "../../enums";

/** Separator between the org id and the user-facing sandbox name. */
const ORG_NAME_SEPARATOR = "/";

/**
 * Canonical name of the pre-built Freestyle preset snapshot for a (preset, size),
 * e.g. `amika-coder-m`, `amika-coder-dind-xl`. This is the single source of truth
 * for the scheme: `server-env.ts` resolves `freestyleSnapshots[preset][size]` to
 * these names, and `bin/freestyle-build-snapshots` snapshots each VM under the
 * matching name (the script mirrors this template — keep them in sync).
 *
 * Freestyle bakes the requested size into the snapshot itself (the build script
 * resizes the VM before snapshotting), mirroring Daytona's per-size image tags
 * (`amika/daytona-coder-m`). At create time the name is resolved to a bootable
 * snapshot id via the snapshot list (see `resolveFreestyleSnapshotRef`), so no
 * post-create `vm.resize` is needed.
 */
export function buildFreestyleSnapshotName(
  preset: SandboxPreset,
  size: SandboxSize,
): string {
  return `amika-${preset}-${size}`;
}

/**
 * Build an org-scoped VM name by prefixing the org id. Mirrors Daytona's
 * `buildSandboxSnapshotName` (`${orgId}/sandbox/${slug}`); the org id (rather
 * than a mutable display value) keeps the prefix stable if the org is renamed.
 * Org ids never contain `/`, so the prefix is unambiguously recoverable by
 * {@link freestyleVmNameOrgId}.
 *
 * Example: buildFreestyleVmName("org_abc123", "my-sandbox")
 *       → "org_abc123/my-sandbox"
 */
export function buildFreestyleVmName(orgId: string, name: string): string {
  return `${orgId}${ORG_NAME_SEPARATOR}${name}`;
}

/**
 * Recover the org id stamped onto a VM name by {@link buildFreestyleVmName},
 * or `null` for a name with no org prefix (e.g. a VM created before this scheme
 * or named directly in the Freestyle dashboard). Splits on the first separator
 * since org ids contain no `/` while the user-facing name may.
 */
export function freestyleVmNameOrgId(vmName: string | null): string | null {
  if (!vmName) return null;
  const idx = vmName.indexOf(ORG_NAME_SEPARATOR);
  if (idx <= 0) return null;
  return vmName.slice(0, idx);
}

/**
 * Whether a VM (by its name) is owned by the given org. A name carrying no org
 * prefix is treated as not belonging to any org (returns `false`) so callers
 * can fail closed.
 */
export function freestyleVmBelongsToOrg(
  vmName: string | null,
  orgId: string,
): boolean {
  return freestyleVmNameOrgId(vmName) === orgId;
}
