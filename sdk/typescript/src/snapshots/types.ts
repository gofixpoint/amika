import { type LegacyShape } from "../internal/types.js";

/**
 * Provider-specific Daytona detail nested under {@link RigSnapshot.daytona}.
 * Only `name` is required by the schema; wire keys are camelCase here.
 */
export interface ExperimentalDaytonaSnapshot {
  /** Resource name. */
  name: string;
  /** Provider-reported snapshot state. Use snapshot.wait() to wait for capture. */
  state?: string;
  /** Provider image name, when reported. */
  imageName?: string;
  /** Provider-reported CPU allocation. */
  cpu?: number;
  /** Provider-reported memory allocation. */
  memory?: number;
  /** Provider-reported disk allocation. */
  disk?: number;
  /** Creation timestamp returned by the server. */
  createdAt?: string;
  /** Last-update timestamp returned by the server. */
  updatedAt?: string;
}

/**
 * A snapshot captured from a running rig, as returned by the
 * `/api/v0beta1/rig-snapshots` endpoints. `snapshot` is the slug used to
 * fork new rigs (pass it as the `snapshot` option to `client.rigs.create`).
 *
 * The four `sourceRig*` / `rig*` fields are the canonical spellings of the
 * `sourceSandbox*` / `sandbox*` ones beside them, decoded from the same wire
 * keys.
 */
export interface RigSnapshot {
  /** Resource identifier assigned by the server. */
  id: string;
  /** Snapshot slug used to create another rig. */
  snapshot: string;
  /** Infrastructure or credential provider reported by the server. */
  provider: string;
  /** Human-readable description; null where none is stored. */
  description: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sourceSandboxId}. */
  sourceRigId: string | null;
  /** Legacy spelling of sourceRigId; carries the same value. */
  sourceSandboxId: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sourceSandboxName}. */
  sourceRigName: string | null;
  /** Legacy spelling of sourceRigName; carries the same value. */
  sourceSandboxName: string | null;
  /** Associated repository ID, or null when unavailable. */
  repositoryId: string | null;
  /** Associated repository URL, or null when unavailable. */
  repositoryUrl: string | null;
  /** Source image or snapshot identifier, or null when unavailable. */
  baseSnapshot: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sandboxPreset}. */
  rigPreset: string | null;
  /** Legacy spelling of rigPreset; carries the same value. */
  sandboxPreset: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sandboxSize}. */
  rigSize: string | null;
  /** Legacy spelling of rigSize; carries the same value. */
  sandboxSize: string | null;
  /** Capture mode reported by the server, such as full or scrub_and_delete. */
  captureMode: string | null;
  /** Snapshot capture state. snapshot.wait() resolves when active and rejects when failed. */
  state: string;
  /** Server-reported failure details, when available. */
  errorMessage: string | null;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
  /** Provider-specific snapshot metadata; null when unavailable. */
  daytona: ExperimentalDaytonaSnapshot | null;
}

/** @deprecated Use {@link RigSnapshot}. */
export type SandboxSnapshot = LegacyShape<
  RigSnapshot,
  "sourceRigId" | "sourceRigName" | "rigPreset" | "rigSize"
>;

/** Shared options for capturing a rig's filesystem. */
export interface RigSnapshotCaptureFields {
  /** Name for the new snapshot. */
  name: string;
  /** Optional human-readable description of the snapshot. */
  description?: string;
  /**
   * Capture mode (default `scrub_and_delete`):
   *   - `scrub_and_delete`: strip Amika-injected secrets, capture the clean
   *     filesystem, then delete the source rig.
   *   - `full`: capture everything as-is (including secrets) and keep the
   *     rig running.
   */
  mode?: "scrub_and_delete" | "full";
}

/**
 * Request body for POST /api/v0beta1/rig-snapshots. The union requires one of
 * the two spellings for the source rig without forcing callers that already
 * pass `sandboxRef` to change.
 */
export type CreateRigSnapshotRequest = RigSnapshotCaptureFields &
  (
    | {
        /** Source rig name or ID. */
        rigRef: string;
        /** @deprecated Use `rigRef`. */
        sandboxRef?: string;
      }
    | {
        /** @deprecated Use `rigRef`. */
        sandboxRef: string;
        /** Source rig name or ID; a non-empty value takes precedence over sandboxRef. */
        rigRef?: string;
      }
  );

/**
 * @deprecated Use {@link CreateRigSnapshotRequest}.
 *
 * Spelled out rather than aliased to the union: under the union a *read* of
 * `sandboxRef` widens to `string | undefined`, because one member declares it
 * optional. That silently breaks 0.11 code doing `const ref: string =
 * req.sandboxRef`. Here `sandboxRef` stays required exactly as it was, and the
 * type is still assignable to {@link CreateRigSnapshotRequest}.
 */
export type CreateSandboxSnapshotRequest = RigSnapshotCaptureFields & {
  /** Source rig, by name or id (the server resolves id first, then name). */
  sandboxRef: string;
  rigRef?: string;
};

/**
 * The injected secrets a scrub-and-delete snapshot would remove from a
 * rig — file paths and env var names only, never values. `restoredFiles`
 * is a third category: paths reset to a retained clean baseline rather than
 * deleted outright.
 */
export interface RigScrubPreview {
  /** Injected-secret file paths that scrubbing would remove. */
  files: string[];
  /** File paths that scrubbing would reset to a clean baseline. */
  restoredFiles: string[];
  /** Environment-variable names affected by scrubbing. */
  envVars: string[];
}

/** @deprecated Use {@link RigScrubPreview}. */
export type SandboxScrubPreview = RigScrubPreview;
