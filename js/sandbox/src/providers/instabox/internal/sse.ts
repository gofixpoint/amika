/**
 * Minimal server-sent events reader for the Instabox exec stream.
 * See https://html.spec.whatwg.org/multipage/server-sent-events.html.
 */

export interface SseEvent {
  /** The `event:` field; `message` when absent. */
  event: string;
  /** The `data:` lines, joined with `\n`. */
  data: string;
}

/** Parse a stream of SSE bytes into events. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let hasData = false;

  function* takeLines(final: boolean): Generator<SseEvent> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      // A lone `\r` at the end may be the first half of `\r\n`.
      if (
        !match ||
        (!final && match[0] === "\r" && match.index === buffer.length - 1)
      ) {
        if (final && buffer !== "") {
          yield* handleLine(buffer);
          buffer = "";
        }
        return;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* handleLine(line);
    }
  }

  function* handleLine(line: string): Generator<SseEvent> {
    if (line === "") {
      if (hasData) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      hasData = false;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      hasData = true;
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* takeLines(false);
    }
    buffer += decoder.decode();
    yield* takeLines(true);
    // A stream may end without the last blank line.
    yield* handleLine("");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
