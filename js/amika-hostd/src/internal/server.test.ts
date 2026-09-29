/** Cover the real HTTP listener: binding and bounded shutdown. */
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { requireSettings, resolveConfig } from "./config.js";
import { startServer } from "./server.js";
import { signServiceToken } from "./services.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const config = {
  ...requireSettings(
    resolveConfig({ env: { AMIKA_HOSTD_SECRET_KEY: SECRET } }),
    ["secretKey"],
  ),
  port: 0,
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return (server.address() as AddressInfo).port;
}

describe("startServer", () => {
  it("forwards a service request with the caller's Host", async () => {
    let seenHost: string | undefined;
    const guest = createServer((req, res) => {
      seenHost = req.headers.host;
      res.end("from guest");
    });
    const guestPort = await listen(guest);
    const smolvm = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          name: "demo",
          state: "running",
          createdAt: 1_790_000_000,
          ports: [{ host: guestPort, guest: 8000 }],
        }),
      );
    });
    const smolvmPort = await listen(smolvm);
    const server = await startServer({
      ...config,
      smolApiUrl: `http://127.0.0.1:${smolvmPort}`,
    });
    try {
      const token = signServiceToken(SECRET, {
        machine: "demo",
        createdAt: 1_790_000_000,
        port: 8000,
        expiresAt: 4_000_000_000,
      });
      // `fetch` would replace Host, so send it with node:http as a proxy in
      // front of hostd (a tunnel) would.
      const body = await new Promise<string>((resolve, reject) => {
        request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: `/services/demo/8000/${token}/`,
            headers: { host: "hostd.example" },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve(text));
          },
        )
          .on("error", reject)
          .end();
      });
      expect(body).toBe("from guest");
      expect(seenHost).toBe("hostd.example");
    } finally {
      await server.close();
      guest.close();
      smolvm.close();
    }
  });

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
