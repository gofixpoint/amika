/** Cover the real HTTP listener: binding and bounded shutdown. */
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireSettings, resolveConfig } from "./config.js";
import { startServer } from "./server.js";
import type { MachineInfo, MachineRuntime } from "./smol.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const config = {
  ...requireSettings(
    resolveConfig({ env: { AMIKA_HOSTD_SECRET_KEY: SECRET } }),
    ["secretKey"],
  ),
  port: 0,
};

const MACHINE: MachineInfo = {
  name: "demo",
  state: "stopped",
  cpus: 4,
  memoryMb: 8192,
  storageGb: 20,
  ports: [],
};

function fakeRuntime() {
  return {
    list: vi.fn(async () => [MACHINE]),
    get: vi.fn(async () => MACHINE),
    create: vi.fn(async () => MACHINE),
    start: vi.fn(async () => MACHINE),
    stop: vi.fn(async () => MACHINE),
    remove: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
  } satisfies MachineRuntime;
}

describe("startServer", () => {
  it("serves on the bound port", async () => {
    const server = await startServer(config, fakeRuntime());
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("answers the machine API from the runtime", async () => {
    const runtime = fakeRuntime();
    const server = await startServer(config, runtime);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v0beta1/rigs`,
        { headers: { Authorization: `Bearer ${SECRET}` } },
      );
      expect(await response.json()).toEqual({ machines: [MACHINE] });
      expect(runtime.list).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("persists service names to the services file", async () => {
    const servicesFile = path.join(
      mkdtempSync(path.join(tmpdir(), "amika-hostd-")),
      "services.json",
    );
    const server = await startServer(config, fakeRuntime(), { servicesFile });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v0beta1/rigs`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "demo",
            image: "ubuntu:24.04",
            services: [{ name: "web", port: 3000 }],
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(JSON.parse(readFileSync(servicesFile, "utf8"))).toEqual({
        demo: { web: 3000 },
      });
    } finally {
      await server.close();
    }
  });

  it("routes upgrades to the service tunnel, refusing a missing key", async () => {
    const server = await startServer(config, fakeRuntime());
    try {
      const client = connect(server.port, "127.0.0.1");
      await once(client, "connect");
      client.write(
        "GET /v0beta1/rigs/demo/services/amikad/v1/status HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      const [chunk] = await once(client, "data");
      expect(String(chunk)).toMatch(/^HTTP\/1\.1 401 /);
      client.destroy();
    } finally {
      await server.close();
    }
  });

  it("cuts off a client still sending its request after the grace period", async () => {
    const server = await startServer(config, fakeRuntime(), {
      shutdownGraceMs: 100,
    });
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
