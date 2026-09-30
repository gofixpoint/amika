import type {
  AgentSendRequest,
  AgentSessionSendResponse,
  AgentSessionStreamHandlers,
} from "../agent-sessions/types.js";
import type { CreateRigRequest, RemoteRig, RemoteSandbox } from "./types.js";

/** Stable lifecycle states. stopped also accepts the API's suspended status. */
export type RigWaitStatus = "running" | "stopped" | "suspended";

/** Readiness conditions and a total deadline for a rig wait. */
export interface RigWaitOptions {
  /** Any listed status matches. Defaults to running. Waiting never starts a rig. */
  status?: RigWaitStatus | readonly RigWaitStatus[];
  /** Defaults to ok when running is among the targets; otherwise setup is not checked. */
  setupStatus?: "ok";
  /** Delay between observations, in milliseconds. Defaults to 3,000. */
  pollMs?: number;
  /** Total deadline including the first fetch and token loading, in milliseconds. Defaults to 900,000. */
  maxWaitMs?: number;
}

/**
 * An unchecked, client-bound rig name or ID. Construct with client.rigs.handle().
 * Construction makes no request and opens no connection. A handle has no fetched
 * metadata; use fetch() or wait() to obtain a Rig. HTTP errors, including 404,
 * propagate from operations. A handle never creates a missing rig.
 */
export interface RigHandle {
  /** Fetch current metadata now. Rejects if the rig does not exist or is inaccessible. */
  fetch(): Promise<Rig>;
  /**
   * Fetch and poll until status and setup match. Defaults to running with successful
   * setup. Throws AmikaWaitError on provisioning/setup failure or deadline expiry.
   * HTTP and transport errors propagate without retrying. Never starts a stopped rig.
   */
  wait(options?: RigWaitOptions): Promise<Rig>;
  /** Request a start; resolves when accepted. Call wait() to establish readiness. */
  start(): Promise<void>;
  /** Request a stop; resolves when accepted. Call wait({ status: "stopped" }) to await it. */
  stop(): Promise<void>;
  /** Delete the rig. HTTP and transport failures propagate. */
  delete(): Promise<void>;
  /** Send a prompt on this rig and return the completed turn. Inspect isError for agent failures. */
  send(request: AgentSendRequest): Promise<AgentSessionSendResponse>;
  /** Send on this rig with ordered, awaited status/text callbacks. Returns the completed turn. */
  sendStream(
    request: AgentSendRequest,
    handlers?: AgentSessionStreamHandlers,
  ): Promise<AgentSessionSendResponse>;
}

/**
 * Fetched rig metadata with operations bound to its ID. Data is an observation,
 * not a live view: refresh() and wait() update and return this same object.
 * Bound methods and client credentials are excluded from JSON and object spreads.
 */
export interface Rig extends RemoteRig, RigHandle {
  /** Fetch current metadata into this object and return it. fetch() behaves the same way. */
  refresh(): Promise<Rig>;
}

/** @deprecated Use Rig. RemoteSandbox remains the plain legacy data shape. */
export type Sandbox = RemoteSandbox & Pick<Rig, "wait" | "delete">;

/** Rig collection operations on client.rigs. */
export interface Rigs {
  /** Create a rig and return its initial metadata. Call rig.wait() for running and successful setup. */
  create(request: CreateRigRequest): Promise<Rig>;
  /** Fetch all rigs accessible to the caller, each with bound operations. */
  list(): Promise<Rig[]>;
  /** Fetch one rig by name or ID immediately. A stopped rig is returned without starting or waiting. */
  get(nameOrId: string): Promise<Rig>;
  /** Construct an unchecked handle without a request. Does not establish existence or readiness. */
  handle(nameOrId: string): RigHandle;
  /** Fetch and wait under one deadline. Uses the first response as the first readiness observation. */
  getAndWait(nameOrId: string, options?: RigWaitOptions): Promise<Rig>;
}
