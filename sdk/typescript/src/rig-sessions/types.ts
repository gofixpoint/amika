/** A lower-level rig session record. Distinct from a durable chat returned by client.agentSessions. */
export interface Session {
  /** Resource identifier assigned by the server. */
  id: string;
  /** The rig this session runs on. Kept under its existing API-compatible name. */
  sandboxId: string;
  /** Organization that owns this resource. */
  orgId: string;
  /** Agent associated with this lower-level session record. */
  agentName: string;
  /** Lower-level session-record status reported by the server. */
  status: string;
  /** Timestamp when execution started. */
  startedAt: string;
  /** Timestamp when execution ended, or null while still running. */
  endedAt: string | null;
  /** Application-defined metadata attached to the session record. */
  metadata: Record<string, unknown>;
  /** First user message, capped by the server. List responses only. */
  preview?: string;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
}

/** Fields for creating a lower-level session record; does not send a prompt. */
export interface CreateSessionRequest {
  /** Agent associated with this lower-level session record. */
  agentName: string;
  /** Application-defined metadata attached to the session record. */
  metadata?: Record<string, unknown>;
}

/** Changes to a lower-level session record. */
export interface UpdateSessionRequest {
  /** New session-record status; omitted fields remain unchanged. */
  status?: string;
  /** Metadata supplied to the session update endpoint. */
  metadata?: Record<string, unknown>;
}

/** Lower-level rig session records, distinct from durable agent chats. */
export interface RigSessions {
  /** Create a lower-level session record on a rig. This does not send a prompt; use client.agentSessions.send for a durable agent chat. */
  create(rigName: string, req: CreateSessionRequest): Promise<Session>;

  /** List lower-level session records on a rig, identified by name or ID. */
  list(rigName: string): Promise<Session[]>;

  /** Fetch the latest session record on the rig. Returns null when the API responds with 404. */
  latest(rigName: string): Promise<Session | null>;

  /** Fetch a lower-level session record by rig reference and session ID. HTTP errors propagate. */
  get(rigName: string, sessionId: string): Promise<Session>;

  /** Update status or metadata on a lower-level session record. This does not send a prompt. */
  update(
    rigName: string,
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<Session>;
}
