/**
 * Minimal Server-Sent Events frame reader, matching the parser Go's
 * `readAgentSessionStream` uses so both transports accept the same streams.
 *
 * Only the subset the Amika API emits is handled: `event:` and `data:` lines
 * terminated by a blank line. Comments (`:`), `id:`, and `retry:` are ignored,
 * and a frame with no `event:` line is dropped (the protocol never sends the
 * default `message` event) — but its buffered data is still discarded, so it
 * cannot bleed into the next frame.
 */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Yield each complete frame from an SSE response body. A trailing frame not
 * followed by a blank line is flushed at end of stream, and a final line
 * without a newline is parsed. Cancels the underlying reader when the consumer
 * stops early.
 */
export async function* readSSEFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let event = "";
  let data = "";

  // Returns the completed frame when `line` terminates one, else undefined.
  const consumeLine = (raw: string): SSEFrame | undefined => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      const frame = event === "" ? undefined : { event, data };
      event = "";
      data = "";
      return frame;
    }
    if (line.startsWith("event:")) {
      // The space after the colon is optional in SSE; strip exactly one.
      event = stripOneSpace(line.slice("event:".length));
      return undefined;
    }
    if (line.startsWith("data:")) {
      // SSE joins multiple data lines with \n; the server emits one line.
      if (data.length > 0) data += "\n";
      data += stripOneSpace(line.slice("data:".length));
    }
    return undefined;
  };

  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += value
        ? decoder.decode(value, { stream: true })
        : decoder.decode();

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = consumeLine(line);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }

      if (done) break;
    }

    // A final line need not be newline-terminated.
    if (buffer.length > 0) {
      const frame = consumeLine(buffer);
      if (frame) yield frame;
    }
    // Flush a trailing frame that never saw its blank line (defensive).
    if (event !== "") yield { event, data };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function stripOneSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}
