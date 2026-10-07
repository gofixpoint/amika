/**
 * Cover the runtime over the `smol` provider, itself over a fake
 * `smolvm serve` reached through an injected `fetch`; no VM ever boots.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  type FileContents,
  RuntimeError,
  providerRuntime,
} from "./machine-runtime.js";

const API_URL = "http://127.0.0.1:23020";
const ROOT = "/api/v1/machines";

interface Port {
  host: number;
  guest: number;
}

/** A machine as `smolvm serve` reports it. */
interface SmolMachine {
  [field: string]: unknown;
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  storageGb?: number;
  ports?: Port[];
}

/** A request the fake smolvm received, with its JSON body parsed. */
interface Received {
  method: string;
  path: string;
  body?: unknown;
}

function machine(overrides: Partial<SmolMachine> = {}): SmolMachine {
  return {
    name: "demo",
    state: "stopped",
    cpus: 4,
    memoryMb: 8192,
    storageGb: 20,
    ...overrides,
  };
}

/**
 * An in-memory `smolvm serve`: the `/api/v1/machines` routes the provider
 * uses, answering as smolvm does. `respond` overrides a route, e.g. to fail
 * it; returning undefined falls through.
 */
function fakeSmolvm(
  initial: SmolMachine[] = [],
  respond?: (method: string, path: string) => Response | undefined,
) {
  const machines = new Map(initial.map((m) => [m.name, { ...m }]));
  const files = new Map<string, Buffer>();
  const received: Received[] = [];
  let execResult = { exitCode: 0, stdout: "out", stderr: "err" };
  const notFound = (what: string) =>
    Response.json({ error: `${what} not found` }, { status: 404 });

  const fetcher = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(API_URL);
      expect(url.pathname.startsWith(ROOT)).toBe(true);
      const path = url.pathname.slice(ROOT.length);
      const method = init.method ?? "GET";
      const binary =
        new Headers(init.headers).get("content-type") ===
        "application/octet-stream";
      const raw = init.body as string | Uint8Array | undefined;
      const body =
        raw === undefined
          ? undefined
          : binary
            ? Buffer.from(raw as Uint8Array)
            : JSON.parse(raw as string);
      received.push({ method, path, ...(body === undefined ? {} : { body }) });
      const override = respond?.(method, path);
      if (override) return override;

      if (path === "") {
        if (method === "GET") {
          return Response.json({ machines: [...machines.values()] });
        }
        const create = body as SmolMachine & { image: string };
        if (machines.has(create.name)) {
          return Response.json(
            { error: `machine ${create.name} already exists` },
            { status: 409 },
          );
        }
        const created = machine({
          name: create.name,
          state: "created",
          cpus: create.cpus ?? 4,
          memoryMb: create.memoryMb ?? 8192,
          storageGb: create.storageGb ?? 20,
          ports: create.ports ?? [],
        });
        machines.set(created.name, created);
        return Response.json(created, { status: 201 });
      }
      const [, name, action, ...rest] = path.split("/");
      const record = machines.get(decodeURIComponent(name!));
      if (!record) return notFound(`machine ${name}`);
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
          const contents = files.get(`/${rest.join("/")}`);
          if (!contents) return notFound("file");
          return new Response(new Uint8Array(contents), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        case "PUT files":
          files.set(`/${rest.join("/")}`, body as Buffer);
          return new Response(null, { status: 204 });
      }
      return Response.json({ error: "no such route" }, { status: 405 });
    },
  );
  return {
    fetch: fetcher as typeof fetch,
    /** The same fake, typed as a mock so tests can read its calls. */
    fetchMock: fetcher,
    machines,
    files,
    received,
    setExecResult: (result: typeof execResult) => (execResult = result),
  };
}

function harness(
  initial: SmolMachine[] = [],
  respond?: (method: string, path: string) => Response | undefined,
) {
  const smolvm = fakeSmolvm(initial, respond);
  return {
    ...smolvm,
    runtime: providerRuntime({ apiUrl: API_URL, fetch: smolvm.fetch }),
  };
}

/** The requests that changed something, i.e. all but reads. */
function writes(received: Received[]) {
  return received.filter((r) => r.method !== "GET");
}

/** The error a runtime call fails with. */
/** A read file's bytes, drained from its stream. */
async function bytes(file: FileContents): Promise<Buffer> {
  return Buffer.from(await new Response(file.body).arrayBuffer());
}

async function failure(call: Promise<unknown>): Promise<RuntimeError> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RuntimeError);
  return error as RuntimeError;
}

const create = { name: "demo", image: "ubuntu:24.04", network: true };

describe("providerRuntime", () => {
  describe("create", () => {
    it("creates the machine with its image, sizes and env, then starts it", async () => {
      const { runtime, received } = harness();
      const info = await runtime.create({
        ...create,
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
        env: [
          { name: "MODE", value: "test" },
          { name: "EMPTY", value: "" },
        ],
      });
      expect(info).toEqual({
        name: "demo",
        state: "running",
        cpus: 2,
        memoryMb: 1024,
        storageGb: 10,
        ports: [],
      });
      expect(writes(received)).toEqual([
        {
          method: "POST",
          path: "",
          body: {
            name: "demo",
            image: "ubuntu:24.04",
            cpus: 2,
            memoryMb: 1024,
            storageGb: 10,
            network: true,
            env: [
              { name: "MODE", value: "test" },
              { name: "EMPTY", value: "" },
            ],
          },
        },
        { method: "POST", path: "/demo/start" },
      ]);
    });

    it("fills smolvm's defaults into a partly sized machine", async () => {
      const { runtime, received } = harness();
      await runtime.create({ ...create, memoryMb: 2048 });
      expect(received[0]!.body).toMatchObject({
        cpus: 4,
        memoryMb: 2048,
        storageGb: 20,
      });
    });

    it("leaves an unsized machine's sizes to smolvm", async () => {
      const { runtime, received } = harness();
      const info = await runtime.create(create);
      const body = received[0]!.body as Record<string, unknown>;
      expect(body.cpus).toBeUndefined();
      expect(body.memoryMb).toBeUndefined();
      expect(body.storageGb).toBeUndefined();
      expect(body.env).toEqual([]);
      expect(info).toMatchObject({ cpus: 4, memoryMb: 8192, storageGb: 20 });
    });

    it.each([true, false])("passes network %s to smolvm", async (network) => {
      const { runtime, received } = harness();
      await runtime.create({ ...create, network });
      expect(received[0]!.body).toMatchObject({ network });
    });

    it("publishes each service's guest port once, on a loopback port", async () => {
      const { runtime, received, machines } = harness();
      await runtime.create({
        ...create,
        services: [
          { name: "web", port: 3000 },
          { name: "web-alias", port: 3000 },
          { name: "amikad", port: 60999 },
        ],
      });
      const { ports, services } = received[0]!.body as {
        ports: Port[];
        services?: unknown;
      };
      // Plain smolvm takes ports, not hostd's named routes.
      expect(services).toBeUndefined();
      expect(ports.map((p) => p.guest)).toEqual([3000, 60999]);
      for (const { host } of ports) {
        expect(Number.isInteger(host) && host > 0).toBe(true);
      }
      expect(machines.get("demo")!.ports).toEqual(ports);
    });

    it("sends no ports without services", async () => {
      const { runtime, received } = harness();
      await runtime.create({ ...create, services: [] });
      expect(received[0]!.body).not.toHaveProperty("ports");
    });

    it("passes on smolvm's refusal of a taken name, starting nothing", async () => {
      const { runtime, received } = harness([machine()]);
      const error = await failure(runtime.create(create));
      expect(error.status).toBe(409);
      expect(error.message).toContain("already exists");
      expect(writes(received)).toEqual([
        expect.objectContaining({ method: "POST", path: "" }),
      ]);
    });

    it("removes a machine that fails to start", async () => {
      const { runtime, received, machines } = harness([], (method, path) =>
        method === "POST" && path === "/demo/start"
          ? Response.json({ error: "boot failed" }, { status: 500 })
          : undefined,
      );
      expect((await failure(runtime.create(create))).status).toBe(500);
      expect(writes(received).map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST ",
        "POST /demo/start",
        "DELETE /demo",
      ]);
      expect(machines.has("demo")).toBe(false);
    });
  });

  describe("list and get", () => {
    it("lists machines in smolvm's shape, published ports included", async () => {
      const { runtime } = harness([
        machine({ ports: [{ host: 40000, guest: 3000 }] }),
        machine({
          name: "other",
          state: "running",
          cpus: 2,
          memoryMb: 512,
          storageGb: 5,
        }),
      ]);
      expect(await runtime.list()).toEqual([
        {
          name: "demo",
          state: "stopped",
          cpus: 4,
          memoryMb: 8192,
          storageGb: 20,
          ports: [{ host: 40000, guest: 3000 }],
        },
        {
          name: "other",
          state: "running",
          cpus: 2,
          memoryMb: 512,
          storageGb: 5,
          ports: [],
        },
      ]);
    });

    it("passes on every field smolvm reports, not just the ones hostd reads", async () => {
      const extra = {
        image: "alpine:3",
        network: false,
        pid: 4242,
        mounts: [{ source: "/src", target: "/work", readonly: true }],
      };
      const { runtime } = harness([machine({ state: "running", ...extra })]);
      expect(await runtime.get("demo")).toMatchObject(extra);
      expect((await runtime.list())[0]).toMatchObject(extra);
      expect(await runtime.stop("demo")).toMatchObject(extra);
      expect(await runtime.start("demo")).toMatchObject(extra);
    });

    it("gets one machine", async () => {
      const { runtime } = harness([machine({ state: "running" })]);
      expect(await runtime.get("demo")).toEqual({
        name: "demo",
        state: "running",
        cpus: 4,
        memoryMb: 8192,
        storageGb: 20,
        ports: [],
      });
    });

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness([machine({ name: "other" })]);
      const error = await failure(runtime.get("demo"));
      expect(error.status).toBe(404);
    });
  });

  describe("start, stop and remove", () => {
    it("starts and stops a machine, reporting its new state", async () => {
      const { runtime, received } = harness([machine()]);
      expect((await runtime.start("demo")).state).toBe("running");
      expect((await runtime.stop("demo")).state).toBe("stopped");
      expect(writes(received)).toEqual([
        { method: "POST", path: "/demo/start" },
        { method: "POST", path: "/demo/stop" },
      ]);
    });

    it("answers a start with the machine smolvm returns, reading nothing back", async () => {
      const { runtime, received } = harness([machine()]);
      expect((await runtime.start("demo")).state).toBe("running");
      expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /demo/start",
      ]);
    });

    it("passes on smolvm's 404 for starting a missing machine", async () => {
      const { runtime } = harness();
      expect((await failure(runtime.start("demo"))).status).toBe(404);
    });

    it("deletes a machine", async () => {
      const { runtime, received, machines } = harness([machine()]);
      await runtime.remove("demo");
      expect(writes(received)).toEqual([{ method: "DELETE", path: "/demo" }]);
      expect(machines.has("demo")).toBe(false);
    });

    it("answers 404 for removing a missing machine, deleting nothing", async () => {
      const { runtime, received } = harness();
      expect((await failure(runtime.remove("demo"))).status).toBe(404);
      expect(writes(received)).toEqual([]);
    });
  });

  describe("exec", () => {
    it("forwards argv, user, workdir, env and stdin to smolvm unchanged", async () => {
      const { runtime, received } = harness([machine({ state: "running" })]);
      const argv = ["printf", "%s|", "it's", "a b", "$HOME", ""];
      const result = await runtime.exec("demo", {
        command: argv,
        user: "ubuntu",
        workdir: "/work",
        env: [{ name: "MODE", value: "test" }],
        stdin: "input",
      });
      expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
      expect(received).toEqual([
        {
          method: "POST",
          path: "/demo/exec",
          body: {
            command: argv,
            user: "ubuntu",
            workdir: "/work",
            env: [{ name: "MODE", value: "test" }],
            stdin: "input",
          },
        },
      ]);
    });

    it("leaves the user to smolvm when the request names none", async () => {
      const { runtime, received } = harness([machine()]);
      await runtime.exec("demo", { command: ["id"] });
      expect(received[0]!.body).toEqual({ command: ["id"] });
    });

    it("passes on smolvm's exact output bytes alongside the decoded text", async () => {
      const reply = {
        exitCode: 0,
        stdout: "\uFFFDPNG",
        stderr: "",
        stdoutB64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        stderrB64: "",
      };
      const smolvm = vi.fn<typeof fetch>(async () => Response.json(reply));
      const runtime = providerRuntime({ apiUrl: API_URL, fetch: smolvm });
      expect(await runtime.exec("demo", { command: ["cat", "a.png"] })).toEqual(
        reply,
      );
    });

    it("passes on a failing command's exit code and output", async () => {
      const { runtime, setExecResult } = harness([machine()]);
      setExecResult({ exitCode: 3, stdout: "", stderr: "boom" });
      expect(await runtime.exec("demo", { command: ["false"] })).toEqual({
        exitCode: 3,
        stdout: "",
        stderr: "boom",
      });
    });

    it("passes on smolvm's 404 for a missing machine", async () => {
      const { runtime } = harness();
      expect(
        (await failure(runtime.exec("demo", { command: ["id"] }))).status,
      ).toBe(404);
    });
  });

  describe("redirects", () => {
    it("asks for redirects to fail on every smolvm request", async () => {
      const { runtime, fetchMock: smolvm } = harness([
        machine({ state: "running" }),
      ]);
      await runtime.get("demo");
      await runtime.exec("demo", { command: ["cat"], stdin: "secret" });
      await runtime.writeFile("demo", "/a", Buffer.from("bytes"));
      await runtime.readFile("demo", "/a");
      await runtime.create({ ...create, name: "fresh" });
      expect(smolvm.mock.calls.length).toBeGreaterThan(5);
      for (const [, init] of smolvm.mock.calls) {
        expect(init?.redirect).toBe("error");
      }
    });

    it("never resends a request to where smolvm redirects it", async () => {
      // Something other than smolvm answering at its address, redirecting.
      const elsewhere = vi.fn();
      const target = createServer((_req, res) => {
        elsewhere();
        res.end("{}");
      });
      const redirector = createServer((_req, res) => {
        const { port } = target.address() as AddressInfo;
        res.writeHead(307, { Location: `http://127.0.0.1:${port}/` }).end();
      });
      target.listen(0, "127.0.0.1");
      redirector.listen(0, "127.0.0.1");
      await Promise.all([
        once(target, "listening"),
        once(redirector, "listening"),
      ]);
      try {
        const { port } = redirector.address() as AddressInfo;
        const runtime = providerRuntime({ apiUrl: `http://127.0.0.1:${port}` });
        const error = await failure(
          runtime.exec("demo", { command: ["cat"], stdin: "secret" }),
        );
        expect(error.status).toBe(502);
        expect(elsewhere).not.toHaveBeenCalled();
      } finally {
        target.close();
        redirector.close();
      }
    });
  });

  describe("files", () => {
    it("writes and reads a file", async () => {
      const { runtime, received, files } = harness([machine()]);
      await runtime.writeFile("demo", "/etc/motd", Buffer.from("hello"));
      expect(received).toEqual([
        {
          method: "PUT",
          path: "/demo/files/etc/motd",
          body: Buffer.from("hello"),
        },
      ]);
      expect(files.get("/etc/motd")?.toString()).toBe("hello");
      const file = await runtime.readFile("demo", "/etc/motd");
      expect(file.contentType).toBe("application/octet-stream");
      expect(await bytes(file)).toEqual(Buffer.from("hello"));
    });

    it("reads bytes that are not UTF-8 unchanged", async () => {
      const { runtime, files } = harness([machine()]);
      const blob = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]);
      files.set("/bin/blob", blob);
      expect(await bytes(await runtime.readFile("demo", "/bin/blob"))).toEqual(
        blob,
      );
    });

    it("keeps smolvm's type for what it reads, a directory's JSON included", async () => {
      const listing = { entries: [{ name: "a", kind: "file", size: 1 }] };
      const smolvm = vi.fn<typeof fetch>(async () => Response.json(listing));
      const runtime = providerRuntime({ apiUrl: API_URL, fetch: smolvm });
      const file = await runtime.readFile("demo", "/etc");
      expect(file.contentType).toBe("application/json");
      expect(JSON.parse((await bytes(file)).toString())).toEqual(listing);
    });

    it("streams what smolvm sends, before the file has all arrived", async () => {
      let finish!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("first"));
          finish = () => {
            controller.enqueue(Buffer.from(" rest"));
            controller.close();
          };
        },
      });
      const smolvm = vi.fn<typeof fetch>(async () => new Response(body));
      const runtime = providerRuntime({ apiUrl: API_URL, fetch: smolvm });
      const reader = (await runtime.readFile("demo", "/big")).body!.getReader();
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(
        "first",
      );
      finish();
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(
        " rest",
      );
      expect((await reader.read()).done).toBe(true);
    });

    it("answers 404 for a missing file", async () => {
      const { runtime } = harness([machine()]);
      const error = await failure(runtime.readFile("demo", "/missing"));
      expect(error.status).toBe(404);
    });
  });

  describe("checkServices", () => {
    const published = machine({
      state: "running",
      ports: [
        { host: 40000, guest: 3000 },
        { host: 40001, guest: 8080 },
      ],
    });

    it("accepts services on published ports", async () => {
      const { runtime } = harness([published]);
      await runtime.checkServices("demo", [
        { name: "web", port: 3000 },
        { name: "api", port: 8080 },
      ]);
    });

    it("accepts dropping a name, whose port stays published", async () => {
      const { runtime, received } = harness([published]);
      await runtime.checkServices("demo", [{ name: "web", port: 3000 }]);
      await runtime.checkServices("demo", []);
      expect(writes(received)).toEqual([]);
    });

    it("refuses with 409 a port the machine did not publish", async () => {
      const { runtime } = harness([published]);
      const error = await failure(
        runtime.checkServices("demo", [
          { name: "web", port: 3000 },
          { name: "db", port: 5432 },
          { name: "db-alias", port: 5432 },
          { name: "cache", port: 6379 },
        ]),
      );
      expect(error.status).toBe(409);
      expect(error.message).toBe(
        "amika-hostd publishes service ports only at create; machine demo does not publish 5432, 6379",
      );
    });

    it("answers 404 for a missing machine", async () => {
      const { runtime } = harness();
      const error = await failure(
        runtime.checkServices("demo", [{ name: "web", port: 3000 }]),
      );
      expect(error.status).toBe(404);
    });
  });

  describe("hostPort", () => {
    const ports = [{ host: 40000, guest: 3000 }];

    it("reports the host port a running machine publishes", async () => {
      const { runtime } = harness([machine({ state: "running", ports })]);
      expect(await runtime.hostPort("demo", 3000)).toBe(40000);
    });

    it("reports none for a stopped machine", async () => {
      const { runtime } = harness([machine({ state: "stopped", ports })]);
      expect(await runtime.hostPort("demo", 3000)).toBeNull();
    });

    it("reports none for an unpublished port", async () => {
      const { runtime } = harness([machine({ state: "running", ports })]);
      expect(await runtime.hostPort("demo", 8080)).toBeNull();
    });

    it("reports none for a missing machine", async () => {
      const { runtime } = harness();
      expect(await runtime.hostPort("demo", 3000)).toBeNull();
    });

    it("reports none when smolvm fails", async () => {
      const { runtime } = harness([machine({ state: "running", ports })], () =>
        Response.json({ error: "down" }, { status: 500 }),
      );
      expect(await runtime.hostPort("demo", 3000)).toBeNull();
    });
  });

  describe("errors", () => {
    it.each([409, 500])("passes on smolvm's %i", async (status) => {
      const { runtime } = harness([machine()], () =>
        Response.json({ error: "refused" }, { status }),
      );
      const error = await failure(runtime.start("demo"));
      expect(error.status).toBe(status);
      expect(error.message).toBe(
        `smolvm POST /demo/start failed (HTTP ${status}): refused`,
      );
    });

    it("answers 502 when smolvm cannot be reached", async () => {
      const runtime = providerRuntime({
        apiUrl: API_URL,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });
      const error = await failure(runtime.list());
      expect(error.status).toBe(502);
      expect(error.message).toBe("fetch failed");
    });

    it("answers 504 when smolvm does not answer in time", async () => {
      const runtime = providerRuntime({
        apiUrl: API_URL,
        fetch: async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
      });
      expect((await failure(runtime.list())).status).toBe(504);
    });

    it("gives each request the configured deadline", async () => {
      const fetcher = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({ machines: [] });
        },
      );
      const runtime = providerRuntime({
        apiUrl: API_URL,
        requestTimeoutMs: 1_000,
        fetch: fetcher,
      });
      expect(await runtime.list()).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("answers 500 for anything else", async () => {
      const { runtime } = harness([], () =>
        Response.json({ unexpected: true }),
      );
      expect((await failure(runtime.list())).status).toBe(500);
    });
  });
});
