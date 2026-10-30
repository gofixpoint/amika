/**
 * Exercise sandbox resources through the real hostd routes and machine
 * runtime: this provider, then hostd's app, then the `smol` provider hostd
 * runs machines through, then a fake `smolvm serve`.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@amika/service-auth/credentials";
import { createApp } from "../../../../amika-hostd/src/app";
// The real store and capture, so this contract test covers hostd's snapshot
// behaviour rather than a stand-in for it.
// eslint-disable-next-line local/no-cross-package-internal -- see above
import { openSnapshotStore } from "../../../../amika-hostd/src/internal/snapshot-store";
// eslint-disable-next-line local/no-cross-package-internal -- see above
import { startCapture } from "../../../../amika-hostd/src/internal/snapshots";
// hostd's app exports no runtime, so this contract test reaches for the one
// its daemon builds.
// eslint-disable-next-line local/no-cross-package-internal -- see above
import { providerRuntime } from "../../../../amika-hostd/src/internal/machine-runtime";
// The real registry, to read what hostd kept of a create's services.
// eslint-disable-next-line local/no-cross-package-internal -- see above
import {
  memoryServiceRegistry,
  type ServiceRegistry,
} from "../../../../amika-hostd/src/internal/service-registry";
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

/** Temporary snapshot directories, removed after each test. */
const snapshotRoots: string[] = [];

/**
 * A `smolvm pack create` that writes the artifact a real one would. The pack
 * is a subprocess in hostd, so a contract test has to stand in for it; every
 * other hop here is the real code.
 */
function fakePack({ code = 0, manual = false } = {}) {
  const packed: string[] = [];
  const finish: (() => void)[] = [];
  const spawn = ((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as never as ChildProcess;
    Object.assign(child, { stdout: null, stderr: null, kill: vi.fn() });
    const done = () => {
      const stub = args[args.indexOf("-o") + 1];
      if (code === 0) {
        writeFileSync(`${stub}.smolmachine`, "packed");
        packed.push(args[args.indexOf("--from-vm") + 1]);
      }
      (child as unknown as EventEmitter).emit("close", code, null);
    };
    if (manual) finish.push(done);
    else queueMicrotask(done);
    return child;
  }) as never;
  // A real pack takes minutes; `manual` holds it so a test can look at the
  // host while it is still running.
  return { spawn, packed, release: () => finish.splice(0).forEach((f) => f()) };
}

function harness({
  config = { secretKey: SECRET },
  machines = [],
  respond,
  amikaUrl,
  snapshots = false,
  pack = fakePack(),
  registry = memoryServiceRegistry(),
}: {
  config?: AmikaHostdConfig;
  machines?: SmolMachine[];
  respond?: (request: Received) => Response | undefined;
  /** hostd's Amika URL, which makes it serve previews. */
  amikaUrl?: string;
  /** Serve the snapshot routes, as a daemon running its own smolvm does. */
  snapshots?: boolean;
  pack?: ReturnType<typeof fakePack>;
  /** hostd's record of each rig's services, to read what create sent. */
  registry?: ServiceRegistry;
} = {}) {
  const fake = fakeSmolvm(machines, respond);
  // What hostd's service routes reach a machine's published ports with.
  const guest = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const runtime = providerRuntime({
    apiUrl: SMOL_API_URL,
    fetch: fake.smolvm,
  });
  let store: ReturnType<typeof openSnapshotStore> | undefined;
  let captures: Promise<void>[] = [];
  if (snapshots) {
    const root = mkdtempSync(path.join(tmpdir(), "amika-hostd-contract-"));
    snapshotRoots.push(root);
    store = openSnapshotStore({
      directory: path.join(root, "snapshots"),
      indexFile: path.join(root, "snapshots.json"),
    });
  }
  const app = createApp({ secretKey: SECRET, amikaUrl }, runtime, {
    fetch: guest,
    registry,
    ...(store
      ? {
          snapshots: {
            store,
            capture: async (rig: string, name: string) => {
              const { done } = await startCapture(
                { rig, name },
                {
                  runtime,
                  store: store!,
                  smolvm: "/usr/local/bin/smolvm",
                  env: {},
                  spawn: pack.spawn,
                },
              );
              captures.push(done);
            },
          },
        }
      : {}),
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) =>
    app.request(new Request(url, init)),
  );
  return {
    ...fake,
    app,
    guest,
    fetcher,
    registry,
    config,
    store,
    pack,
    /** Wait for every capture this harness started. */
    settle: async () => {
      await Promise.all(captures);
      captures = [];
    },
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

afterEach(() => {
  for (const root of snapshotRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    // hostd answers a start or stop with smolvm's machine, reading nothing
    // back, and checks the machine exists before deleting it; the state reads
    // and the listing are the provider's own.
    expect(calls(received)).toEqual([
      "POST /demo/stop",
      "GET /demo",
      "GET ",
      "POST /demo/start",
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
        user: "amika",
        workdir: "/workspace",
        env: [
          { name: "HOME", value: "/home/amika" },
          { name: "A", value: "b" },
        ],
        stdin: "stdin",
      },
    });
    const adapter = await openAmikaHostdAdapter(config, "demo", fetcher);
    const bytes = Buffer.from([0, 255, 128]);
    setExecResult({ exitCode: 0, stdout: "", stderr: "" });
    await adapter.uploadFile(bytes, "/workspace/a #?.bin");
    expect(calls(received.slice(1))).toEqual([
      "POST /demo/exec",
      "PUT /demo/files/workspace/a%20%23%3F.bin",
      "POST /demo/exec",
    ]);
    expect(received[2]).toEqual({
      method: "PUT",
      path: "/demo/files/workspace/a%20%23%3F.bin",
      body: bytes,
    });
    expect(received[3]?.body).toMatchObject({
      command: [
        "/bin/sh",
        "-c",
        "chown -h -- amika:amika '/workspace/a #?.bin'",
      ],
      user: "root",
    });
    expect(files.get("/workspace/a #?.bin")).toEqual(bytes);
    expect(await adapter.downloadFile("/workspace/a.txt")).toBe("hello");
    setExecResult(result);
    expect(await adapter.exec("false")).toEqual(result);
  });

  it("reports the amika user's home, as the cloud providers do", () => {
    expect(harness().provider.userHomeDir).toBe("/home/amika");
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
      snapshots: true,
      // A pack needs the rig stopped, so there is no keep-running capture.
      fullSnapshotCapture: false,
      scrubCapture: true,
      snapshotIdsAreOpaque: false,
      streaming: false,
      supportsAutoDelete: false,
    });
    const sandbox = provider.sandboxes.get("demo");
    expect(sandbox.ssh).toBeNull();
    expect(sandbox.services).not.toBeNull();
    expect(sandbox.snapshots).not.toBeNull();
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

  it("keeps amikad's keyed URL, which hostd routes only with the host key", async () => {
    const { app, provider, guest, machines } = harness();
    await provider.sandboxes.create(ctx, { ...INPUT, services: [AMIKAD] });
    const { services: refreshed } = await provider.sandboxes
      .get("demo")
      .services!.refreshAll([AMIKAD]);
    const url = new URL(refreshed[0].url);
    expect(url.href).toBe(
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/amikad/",
    );
    // The URL alone is no credential: hostd wants the host key alongside.
    // The control plane derives amikad's dials from this URL and sends it.
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

  describe("previews", () => {
    const PREVIEW_HOST = {
      secretKey: SECRET,
      apiUrl: "https://preview.example",
    };
    const AMIKA = "https://app.amika.test";
    /** A browser holding a session for the preview host, as after login. */
    const loggedIn = async () => ({
      Cookie: `__Host-amika-session=${await signSession(SECRET, {
        origin: PREVIEW_HOST.apiUrl,
        user: "user_1",
      })}`,
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    });

    it("hands every service but amikad a preview with no credential", async () => {
      const { provider } = harness({ config: PREVIEW_HOST, amikaUrl: AMIKA });
      await provider.sandboxes.create(ctx, {
        ...INPUT,
        services: [WEB, AMIKAD],
      });
      const { services } = await provider.sandboxes
        .get("demo")
        .services!.refreshAll([WEB, AMIKAD]);
      expect(services[0].url).toBe(
        "https://preview.example/v0beta1/rigs/demo/previews/web/",
      );
      // amikad keeps its keyed route.
      expect(services[1].url).toBe(
        "https://preview.example/v0beta1/rigs/demo/services/amikad/",
      );
      expect(provider.signedUrlTtlSeconds).toBe(12 * 3600);
    });

    it("serves a preview to a browser that logged in, and only to one", async () => {
      const { app, provider, guest, machines } = harness({
        config: PREVIEW_HOST,
        amikaUrl: AMIKA,
      });
      await provider.sandboxes.create(ctx, { ...INPUT, services: [WEB] });
      const { services } = await provider.sandboxes
        .get("demo")
        .services!.refreshAll([WEB]);
      const url = `${services[0].url}assets/app.js?v=1`;

      const response = await app.request(url, { headers: await loggedIn() });
      expect(response.status).toBe(200);
      expect(guest.mock.calls.map(([target]) => target)).toEqual([
        `http://127.0.0.1:${published(machines.get("demo"), 3000)}/assets/app.js?v=1`,
      ]);

      // Without a session, a page load is sent to log in through Amika.
      const anonymous = await app.request(url, {
        headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
      });
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toMatch(/^\/__amika\/login\?/);
      expect(guest).toHaveBeenCalledTimes(1);
    });

    it("tells a browser on a host that cannot log it in to upgrade", async () => {
      // A loopback URL, where no browser cookie can be set.
      const { app, provider } = harness({ amikaUrl: AMIKA });
      await provider.sandboxes.create(ctx, { ...INPUT, services: [WEB] });
      const { services } = await provider.sandboxes
        .get("demo")
        .services!.refreshAll([WEB]);
      expect(services[0].url).toBe(
        "http://127.0.0.1:3020/v0beta1/rigs/demo/previews/web/",
      );
      const login = await app.request(
        new URL("/__amika/login?return=/", services[0].url),
      );
      expect(login.status).toBe(400);
      expect(((await login.json()) as { error: string }).error).toContain(
        "upgrade amika-hostd",
      );
    });
  });

  it("routes a service whose name is free text", async () => {
    const { app, provider, guest, machines } = harness();
    const agent = { ...WEB, name: "Coding Agent" };
    await provider.sandboxes.create(ctx, { ...INPUT, services: [agent] });
    const { services: refreshed } = await provider.sandboxes
      .get("demo")
      .services!.refreshAll([agent]);
    expect(new URL(refreshed[0].url).pathname).toBe(
      "/v0beta1/rigs/demo/previews/Coding%20Agent/",
    );
    const response = await app.request(
      "/v0beta1/rigs/demo/services/Coding%20Agent/",
      { headers: { [HOSTD_SERVICE_KEY_HEADER]: SECRET } },
    );
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
      "http://127.0.0.1:3020/v0beta1/rigs/demo/previews/site/",
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
    ["an empty name", [{ ...WEB, name: "" }], 'named ""'],
    [
      "amikad's name on another port, which could have no URL",
      [{ ...AMIKAD, containerPort: 2222 }],
      'reserves the service name "amikad" for port 60999',
    ],
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
    expect(refreshed[0].url).toBe(
      "http://127.0.0.1:3020/v0beta1/rigs/demo/previews/web/",
    );
    expect(refreshed[1].url).toBe(
      "http://127.0.0.1:3020/v0beta1/rigs/demo/services/amikad/",
    );
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

describe("snapshots", () => {
  const NAME = "org_abc123/sandbox/nightly";
  /**
   * A minimal scrub: the control plane computes the real paths, and this
   * only has to prove they travel through hostd's exec before the capture.
   */
  const TARGETS = {
    files: ["/home/amika/.claude.json"],
    sudoFiles: [],
    sudoFileRestores: [],
    envVarNames: ["ANTHROPIC_API_KEY"],
  };

  /** Scrub and capture, the one mode hostd offers, and wait for the pack. */
  async function captured(h: ReturnType<typeof harness>) {
    const result = await h.provider.sandboxes
      .get("demo")
      .snapshots!.scrubAndCreate(NAME, TARGETS);
    await h.settle();
    return result;
  }

  it("scrubs, stops the rig, packs it, and reports it by name", async () => {
    const h = harness({
      machines: [{ ...MACHINE, state: "running" }],
      snapshots: true,
    });

    const { snapshot, removedFiles, removedEnvVars } = await captured(h);
    expect(removedFiles).toEqual(TARGETS.files);
    expect(removedEnvVars).toEqual(TARGETS.envVarNames);
    // Named, never id-addressed: hostd boots a snapshot by the name the
    // control plane gave it.
    expect(snapshot.providerSnapshotId).toBeNull();
    expect(h.pack.packed).toEqual(["demo"]);
    expect(await h.provider.snapshots!.get(NAME)).toMatchObject({
      name: NAME,
      state: "active",
    });
  });

  it("scrubs the rig before stopping it, which needs it running", async () => {
    const h = harness({
      machines: [{ ...MACHINE, state: "running" }],
      snapshots: true,
    });
    await captured(h);

    // The scrub runs over exec, so it has to happen while the rig is up;
    // smolvm then refuses to pack a running machine, so the stop follows.
    const writes = calls(h.received, { writes: true });
    expect(writes.indexOf("POST /demo/exec")).toBeLessThan(
      writes.indexOf("POST /demo/stop"),
    );
    expect(h.machines.get("demo")?.state).toBe("stopped");
  });

  it("holds the name while the pack runs, then settles active", async () => {
    const pack = fakePack({ manual: true });
    const h = harness({ machines: [MACHINE], snapshots: true, pack });
    const { snapshot } = await h.provider.sandboxes
      .get("demo")
      .snapshots!.scrubAndCreate(NAME, TARGETS);

    // The capture route answers while the pack runs, so the snapshot
    // carries the progress the control plane polls for.
    expect(await h.provider.snapshots!.get(NAME)).toMatchObject({
      state: "capturing",
    });
    pack.release();
    await h.settle();
    expect(await snapshot.waitForActive()).toMatchObject({ state: "active" });
  });

  it("reports why a pack failed rather than hanging on it", async () => {
    const h = harness({
      machines: [MACHINE],
      snapshots: true,
      pack: fakePack({ code: 1 }),
    });
    const { snapshot } = await captured(h);
    // Reported as the terminal `error` the control plane settles on, not
    // hostd's own `failed`, which it would read as still in progress.
    expect(await h.provider.snapshots!.get(NAME)).toMatchObject({
      state: "error",
    });
    await expect(snapshot.waitForActive()).rejects.toThrow(
      /failed on its host/,
    );
  });

  it("refuses the keep-running capture it cannot do", async () => {
    const h = harness({ machines: [MACHINE], snapshots: true });
    // A pack needs the rig stopped, so `fullSnapshotCapture` is false and
    // this is the guard for a caller that ignores the flag.
    await expect(
      h.provider.sandboxes.get("demo").snapshots!.create(NAME),
    ).rejects.toMatchObject({ name: "SandboxProviderUnsupportedError" });
    expect(h.pack.packed).toEqual([]);
  });

  it("has nothing in a rig's environment to scrub", async () => {
    const h = harness({ machines: [MACHINE], snapshots: true });
    // Amika delivers injected secrets at initialize time, into files, so a
    // host rig's create environment never holds one.
    await expect(
      h.provider.sandboxes.get("demo").snapshots!.isEnvScrubbable(),
    ).resolves.toBe(true);
  });

  it("reports a missing snapshot as absent, not as an error", async () => {
    const h = harness({ snapshots: true });
    expect(await h.provider.snapshots!.get(NAME)).toBeNull();
  });

  it("deletes a snapshot it took, and a missing one is done", async () => {
    const h = harness({ machines: [MACHINE], snapshots: true });
    await captured(h);

    const snapshot = await h.provider.snapshots!.get(NAME);
    await snapshot!.delete();
    expect(await h.provider.snapshots!.get(NAME)).toBeNull();
    expect(h.store!.get(NAME)).toBeUndefined();
    // Deleting what is not there is done, as it is for every provider.
    await expect(snapshot!.delete()).resolves.toBeUndefined();
  });

  it("creates a rig from a snapshot by sending its name as the image", async () => {
    const h = harness({ machines: [MACHINE], snapshots: true });
    await captured(h);
    h.received.length = 0;

    await h.provider.sandboxes.create(ctx, {
      ...INPUT,
      name: "child",
      snapshot: NAME,
    });
    // hostd resolved the name against its own store, so smolvm booted the
    // artifact rather than being asked to pull a registry reference whose
    // path merely happens to contain slashes.
    const create = h.received.find((r) => r.method === "POST" && r.path === "");
    const body = create?.body as { image?: string; from?: string };
    expect(body.image).toBeUndefined();
    expect(body.from).toMatch(/\.smolmachine$/);
  });
});

describe("what a service is at its name", () => {
  const PUBLIC: SandboxService = {
    ...WEB,
    name: "app",
    auth: "public",
    preserveHost: true,
  };

  it("sends a service's settings and the rig's owner to hostd, defaults left out", () => {
    expect(
      hostdServiceRoutes([WEB, PUBLIC, { ...WEB, auth: "organization" }]),
    ).toEqual([
      { name: "web", port: 3000 },
      { name: "app", port: 3000, auth: "public", preserve_host: true },
      { name: "web", port: 3000 },
    ]);
  });

  it("has hostd keep the settings and the owner from create, and the settings from a sync", async () => {
    const { provider, registry } = harness();
    await provider.sandboxes.create(ctx, {
      ...INPUT,
      owner: "user_1",
      services: [WEB, PUBLIC, AMIKAD],
    });
    expect(registry.owner("demo")).toBe("user_1");
    expect(registry.entry("demo", "web")).toEqual({
      port: 3000,
      auth: "organization",
      preserveHost: false,
    });
    expect(registry.entry("demo", "app")).toEqual({
      port: 3000,
      auth: "public",
      preserveHost: true,
    });

    const services = provider.sandboxes.get("demo").services!;
    await services
      .load([
        { ...WEB, auth: "owner" },
        { ...PUBLIC, preserveHost: false },
        AMIKAD,
      ])
      .refresh();
    expect(registry.entry("demo", "web")?.auth).toBe("owner");
    expect(registry.entry("demo", "app")).toEqual({
      port: 3000,
      auth: "public",
      preserveHost: false,
    });
    expect(registry.owner("demo")).toBe("user_1");
  });

  it("tells the operator to upgrade a host that refuses the settings", async () => {
    // A hostd from before `service-access` has a strict body: 400.
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/health")
        ? Response.json({ status: "ok" })
        : Response.json({ error: "Unrecognized key: auth" }, { status: 400 }),
    );
    const provider = amikaHostdProvider({
      config: { secretKey: SECRET, apiUrl: "http://old-host:3020" },
      fetcher,
    });
    const upgrade =
      "amika-hostd at http://old-host:3020 refused a service's access settings (auth, preserve_host); upgrade amika-hostd";
    await expect(
      provider.sandboxes.create(ctx, { ...INPUT, services: [PUBLIC] }),
    ).rejects.toThrow(upgrade);
    await expect(
      provider.sandboxes.create(ctx, { ...INPUT, owner: "user_1" }),
    ).rejects.toThrow(upgrade);
    await expect(
      provider.sandboxes.get("demo").services!.load([PUBLIC]).refresh(),
    ).rejects.toThrow(upgrade);
    // A body that sets nothing is refused for some other reason, which is
    // reported as it is.
    await expect(
      provider.sandboxes.create(ctx, { ...INPUT, services: [WEB] }),
    ).rejects.toThrow("HTTP 400");
  });
});
