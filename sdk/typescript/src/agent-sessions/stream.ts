import {
  type AgentSessionStreamHandlers,
  type AgentSessionSendResponse,
} from "./types.js";
import { readSSEFrames } from "../internal/sse.js";
import { str, optionalStr } from "../internal/wire.js";
import { AmikaError } from "../errors.js";
import { agentSessionSendResponseFromWire } from "./wire.js";

/**
 * Consume the send SSE stream, dispatching `status`/`delta` frames to the
 * handlers and returning the terminal `done` result.
 *
 * A completed turn wins over an `error` frame: `done` carries the persisted
 * result, so if both somehow arrive the send succeeded and reporting the error
 * would discard a real session id.
 */
export async function readAgentSessionStream(
  body: ReadableStream<Uint8Array>,
  handlers: AgentSessionStreamHandlers,
): Promise<AgentSessionSendResponse> {
  let streamError = "";

  stream: for await (const frame of readSSEFrames(body)) {
    switch (frame.event) {
      case "status": {
        if (!handlers.onStatus) break;
        // Cosmetic progress only, so an unparseable frame is ignored.
        const parsed = tryParse(frame.data);
        if (parsed) {
          await handlers.onStatus(
            str(parsed["phase"]),
            str(parsed["sandbox_id"]),
          );
        }
        break;
      }
      case "delta": {
        // A delta carries reply text, so an unparseable one is lost output.
        // Fail loudly rather than silently returning a truncated reply.
        const parsed = tryParse(frame.data);
        if (!parsed) {
          // Truncated trailing frame: the connection was cut mid-delta, which
          // is a lost stream, not corrupt output. Stop and report it as such.
          if (!frame.terminated) break stream;
          throw new AmikaError(
            "remote agent-session send: parsing delta frame failed",
          );
        }
        const text = str(parsed["text"]);
        if (text !== "" && handlers.onDelta) await handlers.onDelta(text);
        break;
      }
      case "done": {
        const parsed = tryParse(frame.data);
        if (!parsed) {
          if (!frame.terminated) break stream;
          throw new AmikaError(
            "remote agent-session send: parsing done frame failed",
          );
        }
        // `done` is terminal: stop reading so a later frame cannot discard a
        // completed turn's result.
        return agentSessionSendResponseFromWire(parsed);
      }
      case "error": {
        const parsed = tryParse(frame.data);
        // Same reasoning as delta/done: a cut mid-frame is a lost stream, not
        // a new error. Without this, a truncated error frame overwrites an
        // earlier real message with the generic fallback.
        if (!parsed && !frame.terminated) break stream;
        streamError = optionalStr(parsed?.["error"]) || "stream error";
        break;
      }
    }
  }

  if (streamError !== "") {
    throw new AmikaError(`remote agent-session send: ${streamError}`);
  }
  // No terminal frame. The likeliest cause is the server's own request ceiling
  // (300s) cutting the stream mid-turn, but a clean close with a malformed
  // final frame lands here too and the two are indistinguishable from here, so
  // name both. Either way the turn may have completed and persisted, so point
  // at the session list rather than implying the work was lost.
  throw new AmikaError(
    "remote agent-session send: stream ended without a result " +
      "(the server may have hit its request time limit, or the final frame " +
      "was truncated or malformed; check client.agentSessions.list() for the session)",
  );
}

export function tryParse(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
