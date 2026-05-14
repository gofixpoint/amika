export class AmikaError extends Error {
  override name = "AmikaError";
}

interface APIErrorResponse {
  type?: string;
  code?: string;
  error_code?: string;
  message?: string;
}

/**
 * AmikaHTTPError is thrown when the server responds with a non-2xx status.
 * Mirrors Go's `apiclient.HTTPError`: carries the raw status and body so
 * callers can inspect or parse structured error information.
 */
export class AmikaHTTPError extends AmikaError {
  override name = "AmikaHTTPError";
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`HTTP ${statusCode}: ${userMessageFromBody(body)}`);
    this.statusCode = statusCode;
    this.body = body;
  }

  /**
   * Extract the human-readable message from a structured API error response,
   * prefixing the stable error code when present. Falls back to the raw body
   * if parsing fails. Mirrors Go's `HTTPError.UserMessage()`.
   */
  userMessage(): string {
    return userMessageFromBody(this.body);
  }
}

function userMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as APIErrorResponse;
    if (parsed.message) {
      const code = parsed.code || parsed.error_code;
      return code ? `${code}: ${parsed.message}` : parsed.message;
    }
  } catch {
    // Body wasn't JSON; fall through.
  }
  return body;
}

/**
 * Inspect an error returned by agent-send and return a short description if
 * the root cause is an authentication failure in the agent's AI provider
 * (e.g. Anthropic 401). Returns "" if the error is not auth-related.
 * Port of Go's `extractAgentAuthError`.
 */
export function extractAgentAuthError(err: unknown): string {
  if (!(err instanceof AmikaHTTPError)) return "";

  let envelope: { error?: string; details?: string };
  try {
    envelope = JSON.parse(err.body) as { error?: string; details?: string };
  } catch {
    return "";
  }
  if (!envelope.details) return "";

  let agentResult: { is_error?: boolean; result?: string };
  try {
    agentResult = JSON.parse(envelope.details) as {
      is_error?: boolean;
      result?: string;
    };
  } catch {
    return "";
  }

  if (!agentResult.is_error || !agentResult.result) return "";

  const r = agentResult.result;
  if (
    r.includes("authentication_error") ||
    r.includes("Invalid authentication credentials") ||
    r.includes("Failed to authenticate")
  ) {
    return r;
  }
  return "";
}
