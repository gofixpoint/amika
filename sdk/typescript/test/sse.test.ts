import { describe, it, expect } from "vitest";

import { readSSEFrames, type SSEFrame } from "@/sse";

/** Build a body stream that delivers `chunks` verbatim, one read at a time. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<SSEFrame[]> {
  const frames: SSEFrame[] = [];
  for await (const frame of readSSEFrames(stream)) frames.push(frame);
  return frames;
}

describe("readSSEFrames", () => {
  it("parses event/data pairs separated by blank lines", async () => {
    const frames = await collect(
      streamOf(
        'event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n',
      ),
    );
    expect(frames).toEqual([
      { event: "delta", data: '{"text":"hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const frames = await collect(
      streamOf("event: de", "lta\ndat", 'a: {"text":"hi"}', "\n\n"),
    );
    expect(frames).toEqual([{ event: "delta", data: '{"text":"hi"}' }]);
  });

  it("strips exactly one space after the colon", async () => {
    const frames = await collect(streamOf("event:delta\ndata:  padded\n\n"));
    expect(frames).toEqual([{ event: "delta", data: " padded" }]);
  });

  it("joins multiple data lines with a newline", async () => {
    const frames = await collect(streamOf("event: done\ndata: a\ndata: b\n\n"));
    expect(frames).toEqual([{ event: "done", data: "a\nb" }]);
  });

  it("ignores comments and id lines", async () => {
    const frames = await collect(
      streamOf(": keep-alive\nid: 7\nevent: delta\ndata: x\n\n"),
    );
    expect(frames).toEqual([{ event: "delta", data: "x" }]);
  });

  it("drops an event-less frame without letting its data bleed into the next", async () => {
    const frames = await collect(
      streamOf("data: orphan\n\nevent: delta\ndata: x\n\n"),
    );
    expect(frames).toEqual([{ event: "delta", data: "x" }]);
  });

  it("tolerates CRLF line endings", async () => {
    const frames = await collect(streamOf("event: delta\r\ndata: x\r\n\r\n"));
    expect(frames).toEqual([{ event: "delta", data: "x" }]);
  });

  it("flushes a trailing frame with no blank line and no final newline", async () => {
    const frames = await collect(streamOf("event: done\ndata: {}"));
    expect(frames).toEqual([{ event: "done", data: "{}" }]);
  });

  it("yields nothing for an empty stream", async () => {
    expect(await collect(streamOf())).toEqual([]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const encoded = new TextEncoder().encode("event: delta\ndata: né\n\n");
    // Cut between the two bytes of "é" so the decoder must carry state over.
    const split = encoded.length - 3;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ event: "delta", data: "né" }]);
  });
});
