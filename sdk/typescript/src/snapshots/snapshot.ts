import type {
  CreateRigSnapshotRequest,
  RigScrubPreview,
  RigSnapshot,
} from "./types.js";

/** Filters for snapshots visible to the caller's organization. */
export interface ListRigSnapshotsOptions {
  /** Only snapshots associated with this repository ID. */
  repositoryId?: string;
  /** Only snapshots captured from this rig ID. */
  sourceRigId?: string;
  /** @deprecated Use sourceRigId. A non-empty sourceRigId takes precedence. */
  sourceSandboxId?: string;
}

/** Poll timing for snapshot capture. */
export interface SnapshotWaitOptions {
  /** Delay between observations in milliseconds. Defaults to 3,000. */
  pollMs?: number;
  /** Total deadline including the first fetch in milliseconds. Defaults to 900,000. */
  maxWaitMs?: number;
}

/** An unchecked snapshot name or ID bound to a client. Construction makes no request. */
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
  /** Fetch a snapshot by name or ID now. Does not wait for capture completion. */
  get(nameOrId: string): Promise<Snapshot>;
  /** Construct an unchecked handle without a request. */
  handle(nameOrId: string): SnapshotHandle;
  /** Preview file paths and environment names affected by scrubbing a rig. Never returns secret values. */
  previewScrub(rigRef: string): Promise<RigScrubPreview>;
}
