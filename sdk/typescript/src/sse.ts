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
  /**
   * False when the stream ended before this frame's terminating blank line,
   * i.e. the connection was cut mid-frame and `data` is truncated. A consumer
   * should treat an unparseable unterminated frame as a lost stream rather
   * than as corrupt content.
   */
  terminated: boolean;
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
      const frame =
        event === "" ? undefined : { event, data, terminated: true };
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

  // Unconsumed input, kept as chunks rather than one accumulating string.
  // `buffer += chunk` builds a rope that `indexOf` must flatten, so appending
  // and scanning per chunk costs O(n) each time and O(n^2) over a line as long
  // as a whole agent turn (the `done` frame is exactly that). Joining only when
  // a newline actually arrives keeps the whole read linear.
  let parts: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const chunk = value
        ? decoder.decode(value, { stream: true })
        : decoder.decode();

      if (chunk !== "") parts.push(chunk);
      // No line to emit yet: hold the chunk and read more.
      if (!done && !chunk.includes("\n")) continue;

      let buffer = parts.length === 1 ? parts[0]! : parts.join("");
      parts = [];

      let consumed = 0;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const frame = consumeLine(buffer.slice(consumed, newline));
        consumed = newline + 1;
        if (frame) yield frame;
        newline = buffer.indexOf("\n", consumed);
      }
      if (consumed > 0) buffer = buffer.slice(consumed);
      if (buffer !== "") parts.push(buffer);

      if (done) break;
    }

    // A final line need not be newline-terminated.
    const tail = parts.join("");
    if (tail !== "") {
      const frame = consumeLine(tail);
      if (frame) yield frame;
    }

    // A frame that never saw its blank line is one the connection was cut in
    // the middle of, so its `data` may be truncated. Yield it anyway, marked
    // unterminated, and let the consumer decide: a complete final frame from a
    // server that omitted the trailing blank line is still usable, while a
    // genuinely truncated one is a lost stream rather than corrupt content.
    if (event !== "") yield { event, data, terminated: false };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function stripOneSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}
