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
import {
  pickRef,
  refFieldName,
  type NormalizedRef,
} from "../internal/resource-ref.js";
import type { RigRef } from "../resource-ref.js";

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
  const source = sourceRigOf(r);
  return omitUndefined({
    // Exactly one of sandbox_id / sandbox_name / sandbox_ref; a plain string
    // is sandbox_ref, as this request always sent.
    [refFieldName("sandbox", source)]: source.value,
    name: r.name,
    description: r.description,
    mode: r.mode,
  });
}

/**
 * Resolve the source rig from whichever of the three spellings the caller
 * used. The first non-empty of `rig`, `rigRef`, `sandboxRef` wins, so an empty
 * canonical spelling falls through to a legacy one instead of shadowing it.
 *
 * The union type already rejects a request carrying none, so the throw catches
 * empty strings in all of them, plus callers arriving untyped from JavaScript.
 */
export function sourceRigOf(r: {
  rig?: RigRef;
  rigRef?: string;
  sandboxRef?: string;
}): NormalizedRef {
  const ref = pickRef("rig", r.rig, r.rigRef, r.sandboxRef);
  if (!ref) {
    throw new AmikaError("rig (or its alias rigRef or sandboxRef) is required");
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
