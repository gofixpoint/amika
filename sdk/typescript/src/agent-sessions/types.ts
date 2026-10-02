/** Request for the rig-scoped alias of sendAgentSession. */
export type AgentSendRequest = Pick<
  AgentSessionSendRequest,
  "message" | "newSession" | "sessionId" | "agent" | "model" | "effort"
>;

/** The same durable-chat response returned by sendAgentSession. */
export type AgentSendResponse = AgentSessionSendResponse;

/**
 * Request body for POST /api/v0beta1/agent-sessions. Only `message` is
 * required: `sessionId` continues an existing chat, `rigId` routes into a
 * specific rig, and `repoUrl` is used only when a rig has to be
 * created behind the scenes.
 *
 * `sandboxId` is the legacy spelling of `rigId`. Setting both is allowed and a
 * non-empty `rigId` wins, but there is no reason to.
 */
export interface AgentSessionSendRequest {
  /** User prompt to send to the coding agent. */
  message: string;
  /** Agent name, such as claude or codex. Omission uses the server-selected agent. */
  agent?: string;
  /** Server-supported model; omitted inherits, null resets to the agent default. */
  model?: string | null;
  /** Omitted inherits; null resets. The server validates support for the agent. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** Continue this durable chat. Omit to route by rigId or start a new chat. */
  sessionId?: string;
  /** Target rig name or ID. Omit to let the server select or create a rig. */
  rigId?: string;
  /** @deprecated Use {@link AgentSessionSendRequest.rigId}. */
  sandboxId?: string;
  /** Start a new chat on the selected rig instead of reusing its current chat. */
  newSession?: boolean;
  /** Repository clone URL used only if the server creates a rig. */
  repoUrl?: string;
}

/**
 * Token and cost accounting for one turn. Every field is optional — Claude
 * reports the full set, Codex currently reports none.
 */
export interface AgentSessionUsage {
  /** Reported cost of this turn in US dollars; absent when not reported. */
  costUsd?: number;
  /** Reported input token count. */
  inputTokens?: number;
  /** Reported output token count. */
  outputTokens?: number;
  /** Reported tokens read from the prompt cache. */
  cacheReadTokens?: number;
  /** Reported tokens written to the prompt cache. */
  cacheCreationTokens?: number;
  /** Reported execution duration in milliseconds. */
  durationMs?: number;
  /** Reported number of agent turns. */
  numTurns?: number;
}

/**
 * Response of POST /api/v0beta1/agent-sessions. `sessionId` is the durable
 * chat id to pass back as `sessionId` to continue the chat.
 */
export interface AgentSessionSendResponse {
  /** Durable chat ID. Pass it on a later send to continue the chat. */
  sessionId: string;
  /** The rig the turn ran on. Kept under its existing API-compatible name. */
  sandboxId: string;
  /** Agent that handled this turn. */
  agent: string;
  /** Agent reply text, or failure details when isError is true. */
  response: string;
  /** Whether the agent reported failure. A successful HTTP request can still return true. */
  isError: boolean;
  /** Whether this send started a new durable chat. */
  isNewSession: boolean;
  /** Whether the turn had to create a rig. Named for the wire field. */
  createdSandbox: boolean;
  /** Token and cost accounting, when reported by the agent. */
  usage?: AgentSessionUsage;
}

/**
 * One row of the agent-sessions list. `sandboxName`, `preview`, `model`,
 * `effort`, and `endedAt` are nullable: a chat can outlive the rig whose
 * name it shows, carry no user message to preview, run at the agent CLI's own
 * model and effort, and still be running.
 */
export interface AgentSessionSummary {
  /** Durable chat ID. Pass it on a later send to continue the chat. */
  sessionId: string;
  /** The rig the chat runs on. Kept under its existing API-compatible name. */
  sandboxId: string;
  /** Rig name, or null if the chat outlived its rig. */
  sandboxName: string | null;
  /** Agent running this chat. */
  agent: string;
  /** Chat status reported by the server. */
  status: string;
  /** Preview of the chat, or null when no message is available. */
  preview: string | null;
  /** Model reported by the agent, or null when unspecified. */
  model: string | null;
  /** Reasoning effort reported by the agent, or null when unspecified. */
  effort: string | null;
  /** Timestamp when execution started. */
  startedAt: string;
  /** Timestamp when execution ended, or null while still running. */
  endedAt: string | null;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
}

/**
 * One turn in a chat transcript. `isError` marks an assistant turn the agent
 * reported as failed; it is absent on user turns and on transcripts that
 * predate per-turn error tracking.
 */
export interface AgentSessionMessage {
  /** Message role reported by the server, commonly user or assistant. */
  role: string;
  /** Text of the transcript message. */
  content: string;
  /** Timestamp of the transcript message. */
  timestamp: string;
  /** Whether this assistant turn failed; absent on user messages and older transcripts. */
  isError?: boolean;
}

/** An {@link AgentSessionSummary} plus the chat's full transcript. */
export interface AgentSessionDetail extends AgentSessionSummary {
  /** Full transcript of the fetched chat. */
  messages: AgentSessionMessage[];
}

/**
 * One page of chats plus the total matching the query. `total` exceeds
 * `sessions.length` when the page cuts the list short; report that rather than
 * presenting a truncated list as the whole of it.
 */
export interface ListAgentSessionsResponse {
  /** Chat summaries returned on this page. */
  sessions: AgentSessionSummary[];
  /** Total matching chats; may exceed sessions.length. */
  total: number;
}

/**
 * Progress callbacks for `client.agentSessions.sendStream`. Both are
 * optional. `onStatus` reports lifecycle milestones (`creating_sandbox` /
 * `sandbox_ready` — the server's own phase names, which still say sandbox —
 * the latter carrying the rig id); `onDelta` receives agent reply text as it
 * is produced.
 *
 * A handler may return a promise, and the reader awaits it before reading the
 * next frame. Deltas therefore reach an async handler in order, and one that
 * throws or rejects fails the send instead of becoming an unhandled rejection.
 * A slow handler backpressures the stream, which is the right trade for output
 * that must not interleave.
 *
 * The return type is `unknown` rather than `void | Promise<void>` so that a
 * concise arrow body still type-checks: `(text) => process.stdout.write(text)`
 * returns a boolean, and a union return type would reject it.
 */
export interface AgentSessionStreamHandlers {
  /** Receives a lifecycle phase and rig ID (which can be empty before a rig exists). Returned promises are awaited; rejection fails the send. */
  onStatus?: (phase: string, rigId: string) => unknown;
  /** Receives incremental reply text in order. Returned promises are awaited; rejection fails the send. */
  onDelta?: (text: string) => unknown;
}

/** Options for listing durable agent chats. */
export interface ListAgentSessionsOptions {
  /** Maximum chats to return; omitted or non-positive uses the server default of 50. */
  limit?: number;
  /** Keep only chats on this rig, by name or ID. An unknown rig throws AmikaHTTPError (404); a value matching one rig's ID and another's name throws (409). */
  rigRef?: string;
}

/** AgentSessions operations available on AmikaClient. */
export interface AgentSessions {
  /** Send a prompt and wait for the agent turn to finish (10-minute request timeout). sessionId continues a chat; rigId selects a rig; otherwise the server can create one. Agent failures return isError: true; HTTP failures throw AmikaHTTPError. */
  send(req: AgentSessionSendRequest): Promise<AgentSessionSendResponse>;

  /** Send a prompt with ordered, awaited progress callbacks and return the completed turn. The request timeout is 10 minutes; the server can end it sooner. A stream without a terminal result throws, even if the turn was persisted. Check the session before retrying. */
  sendStream(
    req: AgentSessionSendRequest,
    handlers?: AgentSessionStreamHandlers,
  ): Promise<AgentSessionSendResponse>;

  /** List durable agent chats, newest first, optionally only those on one rig. Omitting limit uses the server default (50). Preserve total when displaying a partial page. */
  list(options?: ListAgentSessionsOptions): Promise<ListAgentSessionsResponse>;

  /** Fetch a durable agent chat and its full message history. Returned operations are bound to its session ID. */
  get(sessionId: string): Promise<AgentSession>;
}

/** A prompt continuing the selected chat, with optional agent/model overrides. */
export type ContinueAgentSessionRequest = Pick<
  AgentSessionSendRequest,
  "message" | "agent" | "model" | "effort"
>;

/** A fetched durable chat with operations bound to its session ID. */
export interface AgentSession extends AgentSessionDetail {
  /** Reload the message history into this object and return it. */
  refresh(): Promise<AgentSession>;
  /** Continue this chat. Returns the completed turn; call refresh() to reload history. */
  send(request: ContinueAgentSessionRequest): Promise<AgentSessionSendResponse>;
  /** Continue this chat with ordered, awaited progress callbacks. */
  sendStream(
    request: ContinueAgentSessionRequest,
    handlers?: AgentSessionStreamHandlers,
  ): Promise<AgentSessionSendResponse>;
}
