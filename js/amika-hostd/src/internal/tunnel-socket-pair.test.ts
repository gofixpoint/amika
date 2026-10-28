import { describe, expect, it } from "vitest";
import { socketPair } from "./tunnel-socket-pair.js";

describe("socketPair", () => {
  it("carries bytes from one end to the other", async () => {
    const [client, server] = socketPair();
    const read = new Promise<string>((resolve) =>
      client.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    server.write("hello");
    expect(await read).toBe("hello");
  });

  it("keeps what a paused reader has not read when the other end goes", async () => {
    // How a `Connection: close` response ends while hostd waits on relay
    // credit, and how an upgraded service closes while the tunnel is backed
    // up: the server's end is destroyed with the tail still buffered here.
    const [client, server] = socketPair();
    client.pause();
    const tail = Buffer.alloc(48 * 1024, 7);
    server.write(tail);
    server.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.destroyed).toBe(false);

    const chunks: Buffer[] = [];
    const ended = new Promise<void>((resolve) => client.once("end", resolve));
    const closed = new Promise<void>((resolve) =>
      client.once("close", resolve),
    );
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    client.resume();
    await ended;
    expect(Buffer.concat(chunks).equals(tail)).toBe(true);
    // Then it goes too: there is nobody left to write to.
    await closed;
  });

  it("hands a failure on as a reset", async () => {
    const [client, server] = socketPair();
    const failed = new Promise<Error>((resolve) =>
      client.once("error", resolve),
    );
    server.on("error", () => {});
    server.destroy(new Error("boom"));
    expect((await failed).message).toBe("boom");
  });
});
