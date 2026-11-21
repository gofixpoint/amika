/** Read newline-delimited JSON (NDJSON) response bodies. */

/** The lines of an NDJSON body, without blank ones. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
      }
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest) yield rest;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
