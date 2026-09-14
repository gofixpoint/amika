import type { AmikaClient } from "@/client";
import type {
  AgentSendRequest,
  AgentSendResponse,
  CreateSandboxRequest,
  RemoteSandbox,
} from "@/types";
import type { WaitOptions } from "@/wait";

/** Options shared by high-level sandbox workflow helpers. */
export interface WorkflowOptions {
  wait?: WaitOptions;
  /** Delete the sandbox when the workflow finishes. Default true. */
  deleteOnExit?: boolean;
}

/** Result of {@link AmikaClient.runAgent}. */
export interface RunAgentResult extends AgentSendResponse {
  sandbox: RemoteSandbox;
}

/** Request body for {@link AmikaClient.runAgent}. */
export type RunAgentRequest = CreateSandboxRequest & {
  message: string;
  agent?: AgentSendRequest["agent"];
  newSession?: AgentSendRequest["newSession"];
  sessionId?: AgentSendRequest["sessionId"];
};

/**
 * Create a sandbox and poll until it is ready. Combines
 * {@link AmikaClient.createSandbox} and {@link AmikaClient.waitForSandbox}.
 */
export async function createSandboxAndWait(
  client: AmikaClient,
  req: CreateSandboxRequest,
  wait?: WaitOptions,
): Promise<RemoteSandbox> {
  const created = await client.createSandbox(req);
  return client.waitForSandbox(created.name, wait);
}

/**
 * Create a sandbox, wait until ready, run `fn`, then delete the sandbox
 * (best-effort). Re-throws errors from `fn` after cleanup.
 */
export async function withSandbox<T>(
  client: AmikaClient,
  req: CreateSandboxRequest,
  fn: (sandbox: RemoteSandbox) => Promise<T>,
  options?: WorkflowOptions,
): Promise<T> {
  const deleteOnExit = options?.deleteOnExit ?? true;
  const created = await client.createSandbox(req);
  try {
    const ready = await client.waitForSandbox(created.name, options?.wait);
    return await fn(ready);
  } finally {
    if (deleteOnExit) {
      try {
        await client.deleteSandbox(created.name);
      } catch {
        // Best-effort cleanup; preserve the original error from fn.
      }
    }
  }
}

/**
 * Provision a sandbox, send one agent message, and optionally delete the
 * sandbox when finished.
 */
export async function runAgent(
  client: AmikaClient,
  req: RunAgentRequest,
  options?: WorkflowOptions,
): Promise<RunAgentResult> {
  const { message, agent, newSession, sessionId, ...sandboxReq } = req;
  return withSandbox(
    client,
    sandboxReq,
    async (sandbox) => {
      const resp = await client.agentSend(sandbox.name, {
        message,
        agent,
        newSession,
        sessionId,
      });
      return { ...resp, sandbox };
    },
    options,
  );
}
