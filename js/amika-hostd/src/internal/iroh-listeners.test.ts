/**
 * The loopback listeners `amika-net`'s `hostd` target reaches, over the
 * real app and the real gateway: the preview listener routes by the
 * dialer's rig headers, the API listener ignores them.
 */
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signSession } from "@amika/service-auth/credentials";
import type { HostdConfigWith } from "./config.js";
import { startIrohListeners, type IrohListeners } from "./iroh-listeners.js";
import type { MachineRuntime } from "./machine-runtime.js";
import { buildHandlers } from "./server.js";

const SECRET = "test-secret-0123456789abcdef0123456789";
const AMIKA = "https://app.amika.test";
const NAME = "web--demo.r.acme.o.amika.test";
const NAMED = { "x-amika-rig": "demo", "x-amika-service": "web" };
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A host whose `demo` rig serves `web` from a guest that records requests. */
async function host() {
  const seen: IncomingHttpHeaders[] = [];
  const guest = createHttpServer((request, response) => {
    seen.push(request.headers);
    response.end(`guest ${request.url}`);
  });
  const guestPort = await listen(guest);
  const dir = mkdtempSync(path.join(tmpdir(), "hd-listen-"));
  const servicesFile = path.join(dir, "services.json");
  writeFileSync(servicesFile, JSON.stringify({ demo: { web: 3000 } }));
  const runtime = {
    hostPort: async () => guestPort,
    list: async () => [],
  } as unknown as MachineRuntime;
  const config = {
    secretKey: SECRET,
    apiUrl: AMIKA,
    smolRequestTimeoutMs: 10_000,
    runtimes: { runtimes: {}, presets: {}, warnings: [] },
  } as unknown as HostdConfigWith<"secretKey">;
  const listeners = await startIrohListeners(
    buildHandlers(config, runtime, { servicesFile }),
  );
  closers.push(() => listeners.close());
  const session = `__Host-amika-session=${await signSession(SECRET, {
    origin: `https://${NAME}`,
    user: "user_1",
  })}`;
  return { listeners, seen, session };
}

async function listen(server: HttpServer): Promise<number> {
  closers.push(() => new Promise((done) => server.close(() => done())));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as AddressInfo).port;
}

function get(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: { host: NAME, ...headers },
        agent: false,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("the preview listener", () => {
  it("routes a dialer stream to the rig service its headers name", async () => {
    const { listeners, seen, session } = await host();
    const port = listeners.admitPreview();
    const answer = await get(port, "/app?q=1", {
      ...NAMED,
      ...NAVIGATE,
      cookie: session,
      "x-amika-authorization": "Bearer forged",
      "x-amika-hostd-key": SECRET,
      "x-amika-anything": "else",
    });
    expect(answer).toEqual({ status: 200, body: "guest /app?q=1" });
    expect(
      Object.keys(seen[0]!).filter((h) => h.startsWith("x-amika-")),
    ).toEqual([]);
  });

  it("closes a connection hostd did not admit", async () => {
    const { listeners, seen, session } = await host();
    const port = listeners.admitPreview();
    await get(port, "/", { ...NAMED, ...NAVIGATE, cookie: session });
    // The one admission is spent.
    await expect(
      get(port, "/", { ...NAMED, ...NAVIGATE, cookie: session }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("admits nothing once the admission runs out", async () => {
    const { session } = await host();
    const handlers = buildHandlers(
      {
        secretKey: SECRET,
        apiUrl: AMIKA,
        smolRequestTimeoutMs: 10_000,
        runtimes: { runtimes: {}, presets: {}, warnings: [] },
      } as unknown as HostdConfigWith<"secretKey">,
      { list: async () => [] } as unknown as MachineRuntime,
    );
    const expiring: IrohListeners = await startIrohListeners(handlers, {
      admitMs: 0,
    });
    closers.push(() => expiring.close());
    const port = expiring.admitPreview();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      get(port, "/", { ...NAMED, ...NAVIGATE, cookie: session }),
    ).rejects.toThrow();
  });
});

describe("the API listener", () => {
  it("ignores the rig headers and asks for the host key", async () => {
    const { listeners, seen, session } = await host();
    const refused = await get(listeners.apiPort, "/app", {
      ...NAMED,
      ...NAVIGATE,
      cookie: session,
    });
    expect(refused.status).toBe(401);
    const health = await get(listeners.apiPort, "/health", {
      ...NAMED,
      authorization: `Bearer ${SECRET}`,
    });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });
    expect(seen).toEqual([]);
  });
});
