/** Cover the real HTTP listener: binding and bounded shutdown. */
import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { requireSettings, resolveConfig } from "./config.js";
import { startServer } from "./server.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const config = {
  ...requireSettings(
    resolveConfig({ env: { AMIKA_HOSTD_SECRET_KEY: SECRET } }),
    ["secretKey"],
  ),
  port: 0,
};

describe("startServer", () => {
  it("serves on the bound port", async () => {
    const server = await startServer(config);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("routes upgrades to the service tunnel, refusing a bad token", async () => {
    const server = await startServer(config);
    try {
      const client = connect(server.port, "127.0.0.1");
      await once(client, "connect");
      client.write(
        "GET /services/demo/60999/bad/v1/ssh-sessions HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      const [chunk] = await once(client, "data");
      expect(String(chunk)).toMatch(/^HTTP\/1\.1 404 /);
      client.destroy();
    } finally {
      await server.close();
    }
  });

  it("cuts off a client still sending its request after the grace period", async () => {
    const server = await startServer(config, { shutdownGraceMs: 100 });
    // An unauthenticated client that never finishes its headers.
    const slow = connect(server.port, "127.0.0.1");
    await once(slow, "connect");
    slow.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
    const closed = once(slow, "close");
    const started = Date.now();
    await server.close();
    await closed;
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
