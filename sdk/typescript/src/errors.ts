/** Base error for SDK validation, lifecycle failures, and HTTP errors. */
export class AmikaError extends Error {
  override name = "AmikaError";
}

/** Why a rig could not reach the requested state. */
export type AmikaWaitErrorReason = "provisioning" | "setup" | "timeout";

/** A failed lifecycle operation or expired wait, with the last observed state. */
export class AmikaWaitError extends AmikaError {
  override name = "AmikaWaitError";
  /** Last observed rig ID; empty if the first fetch did not complete. */
  readonly rigId: string;
  /** Last observed lifecycle status; empty before the first response. */
  readonly status: string;
  /** Last observed provisioning state; empty before the first response. */
  readonly state: string;
  /** Last observed setup status, when known. */
  readonly setupStatus: string | undefined;

  constructor(
    /** Whether waiting failed because of provisioning, setup, or its deadline. */
    readonly reason: AmikaWaitErrorReason,
    message: string,
    rig: { id: string; status: string; state: string; setupStatus?: string },
  ) {
    super(message);
    this.rigId = rig.id;
    this.status = rig.status;
    this.state = rig.state;
    this.setupStatus = rig.setupStatus;
  }
}

interface APIErrorResponse {
  type?: string;
  code?: string;
  error_code?: string;
  message?: string;
}

/**
 * AmikaHTTPError is thrown when the server responds with a non-2xx status.
 * Carries the status and raw response body for inspecting structured errors.
 */
export class AmikaHTTPError extends AmikaError {
  override name = "AmikaHTTPError";
  /** HTTP status code returned by the API. */
  readonly statusCode: number;
  /** Raw response body; use userMessage() for a readable API error. */
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`HTTP ${statusCode}: ${userMessageFromBody(body)}`);
    this.statusCode = statusCode;
    this.body = body;
  }

  /**
   * Extract the human-readable message from a structured API error response,
   * prefixing the stable error code when present. Falls back to the raw body
   * if parsing fails.
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
