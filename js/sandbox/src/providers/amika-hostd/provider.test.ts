/** Exercise sandbox resources through the real hostd routes and a fake runtime. */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../../amika-hostd/src/app";
import { moduleLogger, type SandboxCtx } from "../../logger";
import { getProviderLabel, isSandboxProviderName } from "../capabilities";
import { type CreateSandboxProviderInput } from "../provider";
import type { SandboxService } from "../../types";
import type { AmikaHostdConfig } from "./config";
import { hostdServiceRoutes } from "./internal/services";
import amikaHostdProvider, {
  HOSTD_SERVICE_KEY_HEADER,
  openAmikaHostdAdapter,
  withSecretKey,
} from "./provider";

const INPUT: CreateSandboxProviderInput = {
  name: "demo",
  snapshot: "ubuntu:24.04",
  services: [],
};
const MACHINE = {
  name: "demo",
  state: "stopped",
  cpus: 2,
  memoryMb: 1536,
  storageGb: 20,
};
const WEB: SandboxService = {
  name: "web",
  url: "",
  hostPort: 3000,
  containerPort: 3000,
  protocol: "tcp",
};
const AMIKAD: SandboxService = {
  name: "amikad",
  url: "",
  hostPort: 60999,
  containerPort: 60999,
  protocol: "tcp",
};
const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };
const SECRET = "hostd-secret";

function harness(
  responses: Response[],
  config: AmikaHostdConfig = { secretKey: SECRET },
) {
  const runtime = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected runtime request");
    return response;
  });
  let nextPort = 40_000;
  const app = createApp({ secretKey: SECRET }, runtime, {
    allocatePort: async () => ++nextPort,
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) =>
    app.request(new Request(url, init)),
  );
  return {
    app,
    runtime,
    fetcher,
    config,
    provider: amikaHostdProvider({ config, fetcher }),
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function file(contents: string) {
  return new Response(contents, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}

describe("amika-hostd provider", () => {
  it("creates and starts through hostd with the correct provider identity", async () => {
    const { provider, runtime, fetcher } = harness([
      json(MACHINE, 201),
      json({}),
    ]);
    const sandbox = await provider.sandboxes.create(ctx, {
      ...INPUT,
      resources: { vcpus: 2, memoryGib: 1.5, diskGib: 20 },
      envVars: { MODE: "test" },
    });
    expect(sandbox.provider).toBe("amika-hostd");
    expect(sandbox.created).toEqual({
      provider: "amika-hostd",
      providerSandboxId: "demo",
      services: [],
      envVars: { MODE: "test" },
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3020/v0beta1/rigs",
      "http://127.0.0.1:3020/v0beta1/rigs/demo/start",
    ]);
    expect(JSON.parse(String(runtime.mock.calls[0][1]?.body))).toEqual({
      name: "demo",
      image: "ubuntu:24.04",
      cpus: 2,
      memoryMb: 1536,
      storageGb: 20,
      network: true,
      env: [{ name: "MODE", value: "test" }],
    });
    expect(runtime.mock.calls[1][0]).toBe(
      "http://127.0.0.1:8080/api/v1/machines/demo/start",
    );
  });

  it("tells the operator to upgrade a host that predates the versioned API", async () => {
    // An old hostd has no `/v0beta1/rigs`: its router answers 404.
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "Not Found" }, { status: 404 }),
    );
    const provider = amikaHostdProvider({
      config: { secretKey: SECRET, apiUrl: "http://old-host:3020" },
      fetcher,
    });
    await expect(provider.sandboxes.create(ctx, INPUT)).rejects.toThrow(
      "amika-hostd at http://old-host:3020 does not serve API v0beta1; upgrade amika-hostd",
    );
    expect(fetcher.mock.calls[0][0]).toBe("http://old-host:3020/v0beta1/rigs");
  });

  it("preserves an explicit network opt-out through hostd", async () => {
    const { provider, runtime } = harness([json(MACHINE, 201), json({})], {
      secretKey: SECRET,
      network: false,
    });
    await provider.sandboxes.create(ctx, INPUT);
    expect(JSON.parse(String(runtime.mock.calls[0][1]?.body)).network).toBe(
      false,
    );
  });

  it("stops, observes state, restarts, lists, and deletes without implicit starts", async () => {
    const { provider, runtime } = harness([
      json({}),
      json(MACHINE),
      json({}),
      json({ machines: [MACHINE] }),
      new Response(null, { status: 204 }),
    ]);
    const sandbox = provider.sandboxes.get("demo");
    await sandbox.stop();
    expect(await sandbox.getRuntimeState()).toBe("suspended");
    await sandbox.start();
    expect(await provider.sandboxes.list()).toEqual([
      {
        providerSandboxId: "demo",
        orgId: null,
        state: "stopped",
        sizing: { vcpus: 2, memoryGib: 1.5, diskGib: 20 },
      },
    ]);
    await sandbox.delete();
    expect(
      runtime.mock.calls.map(([url, opts]) => [
        new URL(String(url)).pathname,
        opts?.method,
      ]),
    ).toEqual([
      ["/api/v1/machines/demo/stop", "POST"],
      ["/api/v1/machines/demo", "GET"],
      ["/api/v1/machines/demo/start", "POST"],
      ["/api/v1/machines", "GET"],
      ["/api/v1/machines/demo", "DELETE"],
    ]);
  });

  it("executes commands with stdin and transfers files through the adapter", async () => {
    const result = { exitCode: 4, stdout: "out", stderr: "err" };
    const { provider, runtime, fetcher, config } = harness([
      json(result),
      json({}),
      file("hello"),
      json(result),
    ]);
    const sandbox = provider.sandboxes.get("demo");
    expect(
      await sandbox.exec("cat", {
        input: "stdin",
        cwd: "/workspace",
        env: { A: "b" },
      }),
    ).toEqual(result);
    expect(JSON.parse(String(runtime.mock.calls[0][1]?.body))).toEqual({
      command: ["/bin/sh", "-c", "cat"],
      user: "root",
      workdir: "/workspace",
      env: [{ name: "A", value: "b" }],
      stdin: "stdin",
    });
    const adapter = await openAmikaHostdAdapter(config, "demo", fetcher);
    const bytes = Buffer.from([0, 255, 128]);
    await adapter.uploadFile(bytes, "/workspace/a #?.bin");
    expect(runtime.mock.calls[1][1]?.body).toEqual(bytes);
    expect(runtime.mock.calls[1][0]).toContain(
      "/files/workspace/a%20%23%3F.bin",
    );
    expect(await adapter.downloadFile("/workspace/a.txt")).toBe("hello");
    expect(await adapter.exec("false")).toEqual(result);
  });

  it("cleans up failed starts but never deletes a conflicting machine", async () => {
    const failedStart = harness([json(MACHINE, 201), json({}, 503), json({})]);
    await expect(
      failedStart.provider.sandboxes.create(ctx, INPUT),
    ).rejects.toThrow("HTTP 503");
    expect(failedStart.runtime.mock.calls[2][1]?.method).toBe("DELETE");
    const conflict = harness([json({}, 409)]);
    await expect(
      conflict.provider.sandboxes.create(ctx, INPUT),
    ).rejects.toThrow("HTTP 409");
    expect(conflict.runtime).toHaveBeenCalledTimes(1);
  });

  it("keeps both start and cleanup failures", async () => {
    const { provider } = harness([json(MACHINE), json({}, 500), json({}, 503)]);
    await expect(provider.sandboxes.create(ctx, INPUT)).rejects.toMatchObject({
      message: "Smol start and cleanup failed",
      errors: [
        expect.objectContaining({ status: 500 }),
        expect.objectContaining({ status: 503 }),
      ],
    });
  });

  it("treats 404 as absent only for state, read, and delete", async () => {
    const { provider } = harness([
      json({}, 404),
      json({}, 404),
      json({}, 404),
      json({}, 404),
      json({}, 500),
    ]);
    const sandbox = provider.sandboxes.get("demo");
    expect(await sandbox.getState()).toBe("unknown");
    expect(await sandbox.readFile("/missing")).toBeNull();
    await sandbox.delete();
    await expect(sandbox.start()).rejects.toThrow("HTTP 404");
    await expect(sandbox.readFile("/broken")).rejects.toThrow("HTTP 500");
  });

  it.each([
    { autoStopInterval: 1 },
    { autoDeleteInterval: 1 },
    { services: [{ ...WEB, protocol: "udp" as const }] },
  ])("rejects unsupported options before allocation: %j", async (overrides) => {
    const { provider, runtime } = harness([]);
    await expect(
      provider.sandboxes.create(ctx, { ...INPUT, ...overrides }),
    ).rejects.toMatchObject({ provider: "amika-hostd" });
    expect(runtime).not.toHaveBeenCalled();
  });

  it("has client-safe metadata and accurately limited capabilities", async () => {
    const { provider } = harness([]);
    expect(isSandboxProviderName("amika-hostd")).toBe(true);
    expect(getProviderLabel("amika-hostd")).toBe("Amika Host");
    expect(provider.capabilities).toMatchObject({
      lifecycle: true,
      exec: true,
      listSandboxes: true,
      ssh: false,
      services: true,
      snapshots: false,
      streaming: false,
      supportsAutoDelete: false,
    });
    const sandbox = provider.sandboxes.get("demo");
    expect(sandbox.ssh).toBeNull();
    expect(sandbox.services).not.toBeNull();
    expect(sandbox.snapshots).toBeNull();
    await expect(
      sandbox.streamExec("true", { onStdout: () => {} }),
    ).rejects.toMatchObject({
      name: "SandboxProviderUnsupportedError",
      provider: "amika-hostd",
    });
    await expect(sandbox.start(1)).rejects.toMatchObject({
      provider: "amika-hostd",
    });
  });

  it("honors a custom hostd URL and authenticates every request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(MACHINE));
    const provider = amikaHostdProvider({
      config: {
        apiUrl: "http://host:4000/",
        requestTimeoutMs: 1234,
        secretKey: SECRET,
      },
      fetcher,
    });
    expect(await provider.sandboxes.get("demo").getState()).toBe("stopped");
    expect(fetcher).toHaveBeenCalledWith(
      "http://host:4000/v0beta1/rigs/demo",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        redirect: "error",
      }),
    );
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("keeps a Request's own headers when adding the secret key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const request = new Request("http://host/api/v1/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Trace": "1" },
    });
    await withSecretKey(SECRET, fetcher)(request);
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(Object.fromEntries(headers)).toEqual({
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "x-trace": "1",
    });
  });

  it("is rejected by hostd with the wrong secret key", async () => {
    const { provider, runtime } = harness([], { secretKey: "wrong" });
    const failure = provider.sandboxes.get("demo").getState();
    // hostd's reason comes through; the secret that was sent never does.
    await expect(failure).rejects.toThrow(
      /^smolvm GET \/demo failed \(HTTP 401\): Unauthorized$/,
    );
    expect(runtime).not.toHaveBeenCalled();
  });
});

describe("amika-hostd services", () => {
  const PUBLISHED = {
    ...MACHINE,
    state: "running",
    ports: [
      { host: 40001, guest: 3000 },
      { host: 40002, guest: 60999 },
    ],
  };

  it("sends each service's name and port at create and returns the services", async () => {
    const { provider, runtime } = harness([json(MACHINE, 201), json({})]);
    const services = [WEB, { ...WEB, name: "web-alias" }, AMIKAD];
    const sandbox = await provider.sandboxes.create(ctx, {
      ...INPUT,
      services,
    });
    // hostd turns the names into published ports for smolvm.
    const body = JSON.parse(String(runtime.mock.calls[0][1]?.body));
    expect(body.ports).toEqual([
      { host: 40001, guest: 3000 },
      { host: 40002, guest: 60999 },
    ]);
    expect(body).not.toHaveProperty("services");
    expect(sandbox.created?.services).toEqual(services);
  });

  it("sends no services for a machine without any", async () => {
    const { provider, runtime } = harness([json(MACHINE, 201), json({})]);
    await provider.sandboxes.create(ctx, INPUT);
    const body = JSON.parse(String(runtime.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("ports");
  });

  it("returns stable URLs that hostd routes by name with the host key", async () => {
    const { app, provider, runtime } = harness([
      json(MACHINE, 201),
      json({}),
      json(PUBLISHED),
      json({ ok: true }),
    ]);
    await provider.sandboxes.create(ctx, { ...INPUT, services: [AMIKAD] });
    const { services: refreshed } = await provider.sandboxes
      .get("demo")
      .services!.refreshAll([AMIKAD]);
    const url = new URL(refreshed[0].url);
    expect(url.href).toBe(
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/amikad/",
    );
    expect(provider.signedUrlTtlSeconds).toBeGreaterThan(300 * 24 * 3600);

    // The URL alone is no credential: hostd wants the host key alongside.
    expect((await app.request(url.pathname)).status).toBe(401);
    const response = await app.request(`${url.pathname}v1/status?x=1`, {
      headers: {
        [HOSTD_SERVICE_KEY_HEADER]: SECRET,
        Authorization: "Bearer connect-token",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(runtime.mock.calls.map(([target]) => target).slice(2)).toEqual([
      "http://127.0.0.1:8080/api/v1/machines/demo",
      "http://127.0.0.1:40002/v1/status?x=1",
    ]);
    const forwarded = new Headers(runtime.mock.calls[3][1]?.headers);
    expect(forwarded.get("Authorization")).toBe("Bearer connect-token");
    expect(forwarded.get(HOSTD_SERVICE_KEY_HEADER)).toBeNull();
  });

  it("routes a service whose name is free text", async () => {
    const { app, provider, runtime } = harness([
      json(MACHINE, 201),
      json({}),
      json(PUBLISHED),
      json({ ok: true }),
    ]);
    const agent = { ...WEB, name: "Coding Agent" };
    await provider.sandboxes.create(ctx, { ...INPUT, services: [agent] });
    const { services: refreshed } = await provider.sandboxes
      .get("demo")
      .services!.refreshAll([agent]);
    const url = new URL(refreshed[0].url);
    expect(url.pathname).toBe("/v0beta1/rigs/demo/services/Coding%20Agent/");
    const response = await app.request(url.pathname, {
      headers: { [HOSTD_SERVICE_KEY_HEADER]: SECRET },
    });
    expect(response.status).toBe(200);
    expect(runtime.mock.calls[3][0]).toBe("http://127.0.0.1:40001/");
  });

  it("routes a renamed service by its new name, and a removed one not at all", async () => {
    const { app, provider } = harness([
      json(MACHINE, 201),
      json({}),
      json(PUBLISHED), // rename: hostd checks the ports are published
      json(PUBLISHED), // the new name routes
      json({ ok: true }),
      json(PUBLISHED), // revoke: the remaining set
    ]);
    const key = { [HOSTD_SERVICE_KEY_HEADER]: SECRET };
    await provider.sandboxes.create(ctx, { ...INPUT, services: [WEB] });
    const services = provider.sandboxes.get("demo").services!;
    const site = { ...WEB, name: "site" };
    const { services: renamed } = await services.load([site, AMIKAD]).refresh();
    expect(renamed[0].url).toBe(
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/site/",
    );
    const route = (name: string) =>
      app.request(`/v0beta1/rigs/demo/services/${name}/`, { headers: key });
    expect((await route("web")).status).toBe(404);
    expect((await route("site")).status).toBe(200);

    await services.load([site, AMIKAD]).get(3000)!.revoke();
    expect((await route("site")).status).toBe(404);
  });

  it.each([
    [
      "a service declaring two ports",
      [WEB, { ...WEB, containerPort: 3001 }],
      'one port per service name; "web" declares 3000 and 3001',
    ],
    ["a dot-segment name", [{ ...WEB, name: ".." }], 'named ".."'],
  ])("refuses %s rather than misroute", (_label, services, message) => {
    expect(() => hostdServiceRoutes(services as SandboxService[])).toThrow(
      message,
    );
  });

  it("routes each service by its own name, whatever else is listed", () => {
    // Stable across revocations: a route never depends on its siblings.
    expect(hostdServiceRoutes([WEB, AMIKAD, WEB])).toEqual([
      { name: "web", port: 3000 },
      { name: "amikad", port: 60999 },
      { name: "web", port: 3000 },
    ]);
  });

  it("reconciles only to ports published at create", async () => {
    const { provider } = harness([json(PUBLISHED), json(MACHINE)]);
    const services = provider.sandboxes.get("demo").services!;
    const { services: refreshed } = await services
      .load([WEB, AMIKAD])
      .refresh();
    expect(refreshed.map((s) => s.url)).toEqual([
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/web/",
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/amikad/",
    ]);
    await expect(services.load([WEB]).refresh()).rejects.toThrow(
      "does not publish 3000",
    );
  });

  it("refuses to reconcile a published port to UDP", async () => {
    const { provider, runtime } = harness([]);
    const services = provider.sandboxes.get("demo").services!;
    await expect(
      services.load([{ ...AMIKAD, protocol: "udp" }]).refresh(),
    ).rejects.toMatchObject({
      name: "SandboxProviderUnsupportedError",
      provider: "amika-hostd",
    });
    expect(runtime).not.toHaveBeenCalled();
  });
});
