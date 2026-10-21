import type { ResourceRef, RigRef } from "../resource-ref.js";
import type {
  CreateRigSnapshotRequest,
  RigScrubPreview,
  RigSnapshot,
} from "./types.js";

/** Filters for snapshots visible to the caller's organization. */
export interface ListRigSnapshotsOptions {
  /** Only snapshots associated with this repository ID. */
  repositoryId?: string;
  /**
   * Only snapshots captured from this rig. A plain string matches the rig's ID
   * or name; `{ ref, by: "id" | "name" }` pins one. A name or plain string is
   * resolved to a live rig and throws AmikaHTTPError (404) when none matches;
   * an ID filters on the stored source ID as given, so an unknown ID lists
   * nothing. Takes precedence over sourceRigId and sourceSandboxId when
   * non-empty.
   */
  sourceRig?: RigRef;
  /**
   * @deprecated Use `sourceRig: { ref: id, by: "id" }`, which this maps to.
   * A non-empty sourceRigId takes precedence over sourceSandboxId.
   */
  sourceRigId?: string;
  /** @deprecated Use `sourceRig: { ref: id, by: "id" }`, which this maps to. */
  sourceSandboxId?: string;
}

/** Poll timing for snapshot capture. */
export interface SnapshotWaitOptions {
  /** Delay between observations in milliseconds. Defaults to 3,000. */
  pollMs?: number;
  /** Total deadline including the first fetch in milliseconds. Defaults to 900,000. */
  maxWaitMs?: number;
}

/**
 * An unchecked snapshot reference bound to a client. Construction makes no
 * request. Until fetched, operations use the reference as given; once
 * fetched, they pin the snapshot's ID (`{ ref: snapshot.id, by: "id" }`).
 */
export interface SnapshotHandle {
  /** Fetch current metadata. Rejects if missing or inaccessible. */
  fetch(): Promise<Snapshot>;
  /** Poll until active; throws AmikaError on capture failure or timeout. HTTP errors propagate immediately. */
  wait(options?: SnapshotWaitOptions): Promise<Snapshot>;
  /** Delete this snapshot. HTTP and transport errors propagate. */
  delete(): Promise<void>;
}

/** A fetched snapshot. refresh() and wait() update and return this same object. */
export interface Snapshot extends RigSnapshot, SnapshotHandle {
  /** Reload current metadata into this object; fetch() behaves the same way. */
  refresh(): Promise<Snapshot>;
}

/** Capture, discover, and inspect snapshots through client.snapshots. */
export interface Snapshots {
  /**
   * Begin capture and return the initial snapshot; call snapshot.wait() for completion.
   * The default mode scrubs injected secrets and deletes the source rig. full keeps
   * the rig running and captures its complete filesystem, including credentials.
   */
  create(request: CreateRigSnapshotRequest): Promise<Snapshot>;
  /** List snapshots, optionally filtered by repository or source rig. */
  list(options?: ListRigSnapshotsOptions): Promise<Snapshot[]>;
  /**
   * Fetch a snapshot now. A plain string matches its ID or name (409 if
   * ambiguous); `{ ref, by: "id" | "name" }` pins one. Does not wait for
   * capture completion.
   */
  get(snapshot: ResourceRef): Promise<Snapshot>;
  /** Construct an unchecked handle without a request. Rejects an empty reference immediately. */
  handle(snapshot: ResourceRef): SnapshotHandle;
  /**
   * Preview file paths and environment names affected by scrubbing a rig (see
   * {@link RigRef}). Never returns secret values.
   */
  previewScrub(rig: RigRef): Promise<RigScrubPreview>;
}
