import {
  type ExperimentalDaytonaSnapshot,
  type RigSnapshot,
  type CreateRigSnapshotRequest,
  type RigScrubPreview,
} from "./types.js";
import {
  str,
  optionalStr,
  optionalNum,
  nullableStr,
  optionalObject,
  omitUndefined,
  strArray,
} from "../internal/wire.js";
import { AmikaError } from "../errors.js";

export function experimentalDaytonaSnapshotFromWire(
  w: Record<string, unknown>,
): ExperimentalDaytonaSnapshot {
  return {
    name: str(w["name"]),
    state: optionalStr(w["state"]),
    imageName: optionalStr(w["imageName"]),
    cpu: optionalNum(w["cpu"]),
    memory: optionalNum(w["memory"]),
    disk: optionalNum(w["disk"]),
    createdAt: optionalStr(w["createdAt"]),
    updatedAt: optionalStr(w["updatedAt"]),
  };
}

export function rigSnapshotFromWire(w: Record<string, unknown>): RigSnapshot {
  return {
    id: str(w["id"]),
    snapshot: str(w["snapshot"]),
    provider: str(w["provider"]),
    description: nullableStr(w["description"]),
    sourceRigId: nullableStr(w["source_sandbox_id"]),
    sourceSandboxId: nullableStr(w["source_sandbox_id"]),
    sourceRigName: nullableStr(w["source_sandbox_name"]),
    sourceSandboxName: nullableStr(w["source_sandbox_name"]),
    repositoryId: nullableStr(w["repository_id"]),
    repositoryUrl: nullableStr(w["repository_url"]),
    baseSnapshot: nullableStr(w["base_snapshot"]),
    rigPreset: nullableStr(w["sandbox_preset"]),
    sandboxPreset: nullableStr(w["sandbox_preset"]),
    rigSize: nullableStr(w["sandbox_size"]),
    sandboxSize: nullableStr(w["sandbox_size"]),
    captureMode: nullableStr(w["capture_mode"]),
    state: str(w["state"]),
    errorMessage: nullableStr(w["error_message"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
    daytona:
      optionalObject(w["daytona"], experimentalDaytonaSnapshotFromWire) ?? null,
  };
}

export function createRigSnapshotRequestToWire(
  r: CreateRigSnapshotRequest,
): Record<string, unknown> {
  return omitUndefined({
    sandbox_ref: rigRefOf(r),
    name: r.name,
    description: r.description,
    mode: r.mode,
  });
}

/**
 * Resolve the source rig from whichever of the two spellings the caller used.
 * A non-empty `rigRef` wins; `||` rather than `??` so an empty rig spelling
 * falls through to the legacy one instead of shadowing it.
 *
 * The union above already rejects a request carrying neither, so the throw
 * catches an empty string in both, plus callers arriving untyped from
 * JavaScript.
 */
export function rigRefOf(r: { rigRef?: string; sandboxRef?: string }): string {
  const ref = r.rigRef || r.sandboxRef;
  if (!ref) {
    throw new AmikaError("rigRef (or its alias sandboxRef) is required");
  }
  return ref;
}

export function rigScrubPreviewFromWire(
  w: Record<string, unknown>,
): RigScrubPreview {
  return {
    files: strArray(w["files"]),
    restoredFiles: strArray(w["restored_files"]),
    envVars: strArray(w["env_vars"]),
  };
}
