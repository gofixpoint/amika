/**
 * Exercise sandbox resources through the real hostd routes and machine
 * runtime: this provider, then hostd's app, then the `smol` provider hostd
 * runs machines through, then a fake `smolvm serve`.
 */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../../amika-hostd/src/app";
// hostd's app exports no runtime, so this contract test reaches for the one
// its daemon builds.
// eslint-disable-next-line local/no-cross-package-internal -- see above
import { providerRuntime } from "../../../../amika-hostd/src/internal/machine-runtime";
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

interface Port {
  host: number;
  guest: number;
}

/** A machine as `smolvm serve` reports it. */
interface SmolMachine {
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  storageGb: number;
  ports?: Port[];
}

const MACHINE: SmolMachine = {
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
/** Where hostd reaches smolvm; set so tests do not depend on its default. */
const SMOL_API_URL = "http://127.0.0.1:23020";
const SMOL_MACHINES = "/api/v1/machines";

/** A request smolvm received, by method and path under its machines API. */
interface Received {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * An in-memory `smolvm serve`, answering the machine routes as smolvm does.
 * `respond` overrides a request, e.g. to fail it; undefined falls through.
 */
function fakeSmolvm(
  initial: SmolMachine[],
  respond?: (request: Received) => Response | undefined,
) {
  const machines = new Map(initial.map((m) => [m.name, { ...m }]));
  const files = new Map<string, Buffer>();
  const received: Received[] = [];
  let execResult = { exitCode: 0, stdout: "", stderr: "" };
  const notFound = () => Response.json({ error: "not found" }, { status: 404 });
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(SMOL_API_URL);
    const path = url.pathname.slice(SMOL_MACHINES.length);
    const method = init.method ?? "GET";
    const binary =
      new Headers(init.headers).get("content-type") ===
      "application/octet-stream";
    const raw = init.body as string | Uint8Array | undefined;
    const request: Received = { method, path };
    if (raw !== undefined) {
      request.body = binary
        ? Buffer.from(raw as Uint8Array)
        : JSON.parse(raw as string);
    }
    received.push(request);
    const override = respond?.(request);
    if (override) return override;
    if (path === "") {
      if (method === "GET") {
        return Response.json({ machines: [...machines.values()] });
      }
      const body = request.body as Partial<SmolMachine> & { name: string };
      if (machines.has(body.name)) {
        return Response.json({ error: "exists" }, { status: 409 });
      }
      const created: SmolMachine = {
        name: body.name,
        state: "created",
        cpus: body.cpus ?? 4,
        memoryMb: body.memoryMb ?? 8192,
        storageGb: body.storageGb ?? 20,
        ports: body.ports ?? [],
      };
      machines.set(created.name, created);
      return Response.json(created, { status: 201 });
    }
    const [, name, action, ...rest] = path.split("/");
    const record = machines.get(decodeURIComponent(name!));
    if (!record) return notFound();
    const file = decodeURIComponent(`/${rest.join("/")}`);
    switch (`${method} ${action ?? ""}`) {
      case "GET ":
        return Response.json(record);
      case "DELETE ":
        machines.delete(record.name);
        return new Response(null, { status: 204 });
      case "POST start":
        record.state = "running";
        return Response.json(record);
      case "POST stop":
        record.state = "stopped";
        return Response.json(record);
      case "POST exec":
        return Response.json(execResult);
      case "GET files": {
        const contents = files.get(file);
        if (!contents) return notFound();
        return new Response(new Uint8Array(contents), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      case "PUT files":
        files.set(file, request.body as Buffer);
        return new Response(null, { status: 204 });
    }
    return Response.json({ error: "no such route" }, { status: 405 });
  });
  return {
    smolvm: fetcher,
    machines,
    files,
    received,
    setExecResult: (result: typeof execResult) => (execResult = result),
  };
}

function harness({
  config = { secretKey: SECRET },
  machines = [],
  respond,
}: {
  config?: AmikaHostdConfig;
  machines?: SmolMachine[];
  respond?: (request: Received) => Response | undefined;
} = {}) {
  const fake = fakeSmolvm(machines, respond);
  // What hostd's service routes reach a machine's published ports with.
  const guest = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const app = createApp(
    { secretKey: SECRET },
    providerRuntime({ apiUrl: SMOL_API_URL, fetch: fake.smolvm }),
    { fetch: guest },
  );
  const fetcher = vi.fn<typeof fetch>(async (url, init) =>
    app.request(new Request(url, init)),
  );
  return {
    ...fake,
    app,
    guest,
    fetcher,
    config,
    provider: amikaHostdProvider({ config, fetcher }),
  };
}

/** smolvm's requests as `METHOD path`, optionally only those that change things. */
function calls(received: Received[], { writes = false } = {}) {
  return received
    .filter((r) => !writes || r.method !== "GET")
    .map((r) => `${r.method} ${r.path}`);
}

/** The host port smolvm published a machine's guest port on. */
function published(machine: SmolMachine | undefined, guest: number) {
  const host = machine?.ports?.find((p) => p.guest === guest)?.host;
  expect(host).toBeGreaterThan(0);
  return host!;
}

describe("amika-hostd provider", () => {
  it("creates and starts through hostd with the correct provider identity", async () => {
    const { provider, received, fetcher, machines } = harness();
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
    expect(received[0]).toEqual({
      method: "POST",
      path: "",
      body: {
        name: "demo",
        image: "ubuntu:24.04",
        cpus: 2,
        memoryMb: 1536,
        storageGb: 20,
        network: true,
        env: [{ name: "MODE", value: "test" }],
      },
    });
    // hostd's create starts the machine too; the control plane's start then
    // starts it again, harmlessly.
    expect(calls(received, { writes: true })).toEqual([
      "POST ",
      "POST /demo/start",
      "POST /demo/start",
    ]);
    expect(machines.get("demo")?.state).toBe("running");
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
    const { provider, received } = harness({
      config: { secretKey: SECRET, network: false },
    });
    await provider.sandboxes.create(ctx, INPUT);
    expect((received[0].body as { network: boolean }).network).toBe(false);
  });

  it("stops, observes state, restarts, lists, and deletes without implicit starts", async () => {
    const { provider, received, machines } = harness({
      machines: [{ ...MACHINE, state: "running" }],
    });
    const sandbox = provider.sandboxes.get("demo");
    await sandbox.stop();
    expect(await sandbox.getRuntimeState()).toBe("stopped");
    expect(await provider.sandboxes.list()).toEqual([
      {
        providerSandboxId: "demo",
        orgId: null,
        state: "stopped",
        sizing: { vcpus: 2, memoryGib: 1.5, diskGib: 20 },
      },
    ]);
    await sandbox.start();
    await sandbox.delete();
    expect(machines.size).toBe(0);
    // hostd reads the machine back after each change, and checks it exists
    // before deleting it; the listing is the provider's own.
    expect(calls(received)).toEqual([
      "POST /demo/stop",
      "GET /demo",
      "GET /demo",
      "GET ",
      "POST /demo/start",
      "GET /demo",
      "GET /demo",
      "DELETE /demo",
    ]);
  });

  it("executes commands with stdin and transfers files through the adapter", async () => {
    const result = { exitCode: 4, stdout: "out", stderr: "err" };
    const { provider, received, fetcher, config, files, setExecResult } =
      harness({ machines: [{ ...MACHINE, state: "running" }] });
    setExecResult(result);
    files.set("/workspace/a.txt", Buffer.from("hello"));
    const sandbox = provider.sandboxes.get("demo");
    expect(
      await sandbox.exec("cat", {
        input: "stdin",
        cwd: "/workspace",
        env: { A: "b" },
      }),
    ).toEqual(result);
    // hostd forwards the control plane's argv and user to smolvm unchanged.
    expect(received[0]).toEqual({
      method: "POST",
      path: "/demo/exec",
      body: {
        command: ["/bin/sh", "-c", "cat"],
        user: "root",
        workdir: "/workspace",
        env: [{ name: "A", value: "b" }],
        stdin: "stdin",
      },
    });
    const adapter = await openAmikaHostdAdapter(config, "demo", fetcher);
    const bytes = Buffer.from([0, 255, 128]);
    await adapter.uploadFile(bytes, "/workspace/a #?.bin");
    expect(received[1]).toEqual({
      method: "PUT",
      path: "/demo/files/workspace/a%20%23%3F.bin",
      body: bytes,
    });
    expect(files.get("/workspace/a #?.bin")).toEqual(bytes);
    expect(await adapter.downloadFile("/workspace/a.txt")).toBe("hello");
    expect(await adapter.exec("false")).toEqual(result);
  });

  it("cleans up failed starts but never deletes a conflicting machine", async () => {
    // hostd's own start, right after create, fails: hostd removes it.
    const hostdStart = harness({
      respond: ({ method, path }) =>
        method === "POST" && path === "/demo/start"
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await expect(
      hostdStart.provider.sandboxes.create(ctx, INPUT),
    ).rejects.toThrow("HTTP 503");
    expect(calls(hostdStart.received, { writes: true })).toEqual([
      "POST ",
      "POST /demo/start",
      "DELETE /demo",
    ]);
    expect(hostdStart.machines.size).toBe(0);

    // The control plane's start fails: it removes the machine through hostd.
    let starts = 0;
    const failedStart = harness({
      respond: ({ method, path }) =>
        method === "POST" && path === "/demo/start" && ++starts === 2
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await expect(
      failedStart.provider.sandboxes.create(ctx, INPUT),
    ).rejects.toThrow("HTTP 503");
    expect(calls(failedStart.received, { writes: true })).toEqual([
      "POST ",
      "POST /demo/start",
      "POST /demo/start",
      "DELETE /demo",
    ]);
    expect(failedStart.machines.size).toBe(0);

    const conflict = harness({ machines: [MACHINE] });
    await expect(
      conflict.provider.sandboxes.create(ctx, INPUT),
    ).rejects.toThrow("HTTP 409");
    expect(calls(conflict.received)).toEqual(["POST "]);
    expect(conflict.machines.has("demo")).toBe(true);
  });

  it("keeps both start and cleanup failures", async () => {
    let starts = 0;
    const { provider } = harness({
      respond: ({ method, path }) => {
        if (method === "POST" && path === "/demo/start" && ++starts === 2) {
          return Response.json({}, { status: 500 });
        }
        if (method === "DELETE") return Response.json({}, { status: 503 });
        return undefined;
      },
    });
    await expect(provider.sandboxes.create(ctx, INPUT)).rejects.toMatchObject({
      message: "Smol start and cleanup failed",
      errors: [
        expect.objectContaining({ status: 500 }),
        expect.objectContaining({ status: 503 }),
      ],
    });
  });

  it("treats 404 as absent only for state, read, and delete", async () => {
    const { provider, received } = harness({
      respond: ({ path }) =>
        path === "/demo/files/broken"
          ? Response.json({}, { status: 500 })
          : undefined,
    });
    const sandbox = provider.sandboxes.get("demo");
    expect(await sandbox.getState()).toBe("unknown");
    expect(await sandbox.readFile("/missing")).toBeNull();
    await sandbox.delete();
    await expect(sandbox.start()).rejects.toThrow("HTTP 404");
    await expect(sandbox.readFile("/broken")).rejects.toThrow("HTTP 500");
    // hostd never deletes a machine smolvm does not list.
    expect(calls(received, { writes: true })).toEqual(["POST /demo/start"]);
  });

  it.each([
    { autoStopInterval: 1 },
    { autoDeleteInterval: 1 },
    { services: [{ ...WEB, protocol: "udp" as const }] },
  ])("rejects unsupported options before allocation: %j", async (overrides) => {
    const { provider, smolvm } = harness();
    await expect(
      provider.sandboxes.create(ctx, { ...INPUT, ...overrides }),
    ).rejects.toMatchObject({ provider: "amika-hostd" });
    expect(smolvm).not.toHaveBeenCalled();
  });

  it("has client-safe metadata and accurately limited capabilities", async () => {
    const { provider } = harness();
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
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(MACHINE));
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
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
    const { provider, smolvm } = harness({ config: { secretKey: "wrong" } });
    const failure = provider.sandboxes.get("demo").getState();
    // hostd's reason comes through; the secret that was sent never does.
    await expect(failure).rejects.toThrow(
      /^smolvm GET \/demo failed \(HTTP 401\): Unauthorized$/,
    );
    expect(smolvm).not.toHaveBeenCalled();
  });
});

describe("amika-hostd services", () => {
  it("publishes each service's port once at create and returns the services", async () => {
    const { provider, received, machines } = harness();
    const services = [WEB, { ...WEB, name: "web-alias" }, AMIKAD];
    const sandbox = await provider.sandboxes.create(ctx, {
      ...INPUT,
      services,
    });
    // hostd hands the names' ports to the smol provider, which publishes
    // each guest port once on a loopback port it picks.
    const body = received[0].body as { ports: Port[] };
    expect(body.ports.map((p) => p.guest)).toEqual([3000, 60999]);
    expect(body).not.toHaveProperty("services");
    expect(machines.get("demo")?.ports).toEqual(body.ports);
    expect(sandbox.created?.services).toEqual(services);
  });

  it("sends no services for a machine without any", async () => {
    const { provider, received } = harness();
    await provider.sandboxes.create(ctx, INPUT);
    expect(received[0].body).not.toHaveProperty("ports");
  });

  it("returns stable URLs that hostd routes by name with the host key", async () => {
    const { app, provider, guest, machines } = harness();
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
    const port = published(machines.get("demo"), 60999);
    expect(guest.mock.calls.map(([target]) => target)).toEqual([
      `http://127.0.0.1:${port}/v1/status?x=1`,
    ]);
    const forwarded = new Headers(guest.mock.calls[0][1]?.headers);
    expect(forwarded.get("Authorization")).toBe("Bearer connect-token");
    expect(forwarded.get(HOSTD_SERVICE_KEY_HEADER)).toBeNull();
  });

  it("routes a service whose name is free text", async () => {
    const { app, provider, guest, machines } = harness();
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
    expect(guest.mock.calls[0][0]).toBe(
      `http://127.0.0.1:${published(machines.get("demo"), 3000)}/`,
    );
  });

  it("routes nothing for a stopped machine", async () => {
    const { app, provider, guest } = harness();
    await provider.sandboxes.create(ctx, { ...INPUT, services: [WEB] });
    await provider.sandboxes.get("demo").stop();
    const response = await app.request("/v0beta1/rigs/demo/services/web/", {
      headers: { [HOSTD_SERVICE_KEY_HEADER]: SECRET },
    });
    expect(response.status).toBe(404);
    expect(guest).not.toHaveBeenCalled();
  });

  it("routes a renamed service by its new name, and a removed one not at all", async () => {
    const { app, provider } = harness();
    const key = { [HOSTD_SERVICE_KEY_HEADER]: SECRET };
    await provider.sandboxes.create(ctx, {
      ...INPUT,
      services: [WEB, AMIKAD],
    });
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
    expect((await route("amikad")).status).toBe(200);
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
    const { provider } = harness({
      machines: [
        {
          ...MACHINE,
          state: "running",
          ports: [
            { host: 40001, guest: 3000 },
            { host: 40002, guest: 60999 },
          ],
        },
        { ...MACHINE, name: "bare" },
      ],
    });
    const services = provider.sandboxes.get("demo").services!;
    const { services: refreshed } = await services
      .load([WEB, AMIKAD])
      .refresh();
    expect(refreshed.map((s) => s.url)).toEqual([
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/web/",
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/amikad/",
    ]);
    await expect(
      provider.sandboxes.get("bare").services!.load([WEB]).refresh(),
    ).rejects.toThrow("machine bare does not publish 3000");
  });

  it("refuses to reconcile a published port to UDP", async () => {
    const { provider, smolvm } = harness();
    const services = provider.sandboxes.get("demo").services!;
    await expect(
      services.load([{ ...AMIKAD, protocol: "udp" }]).refresh(),
    ).rejects.toMatchObject({
      name: "SandboxProviderUnsupportedError",
      provider: "amika-hostd",
    });
    expect(smolvm).not.toHaveBeenCalled();
  });
});
