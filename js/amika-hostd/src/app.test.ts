/** Exercise the daemon's HTTP boundary with an injected machine runtime. */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { memoryServiceRegistry } from "./internal/service-registry.js";
import {
  RuntimeError,
  type CreateMachine,
  type ExecRequest,
  type ExecResult,
  type FileContents,
  type MachineInfo,
  type MachineRuntime,
  type ServicePort,
} from "./internal/machine-runtime.js";

const ROOT = "/api/v1/machines";
const SECRET = "test-secret";

const MACHINE: MachineInfo = {
  name: "demo",
  state: "stopped",
  cpus: 4,
  memoryMb: 8192,
  storageGb: 20,
  ports: [],
};

/** A runtime whose every call succeeds with `machine`, recording its calls. */
function fakeRuntime(machine: MachineInfo = MACHINE) {
  return {
    list: vi.fn(async () => [machine]),
    get: vi.fn(async (_name: string) => machine),
    create: vi.fn(async (_machine: CreateMachine) => machine),
    start: vi.fn(async (_name: string) => ({ ...machine, state: "running" })),
    stop: vi.fn(async (_name: string) => ({ ...machine, state: "stopped" })),
    remove: vi.fn(async (_name: string) => {}),
    exec: vi.fn(
      async (_name: string, _request: ExecRequest): Promise<ExecResult> => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    ),
    readFile: vi.fn(
      async (_name: string, _path: string): Promise<FileContents> => ({
        body: null,
        contentType: "application/octet-stream",
      }),
    ),
    writeFile: vi.fn(
      async (_name: string, _path: string, _data: Uint8Array) => {},
    ),
    checkServices: vi.fn(async (_name: string, _services: ServicePort[]) => {}),
    hostPort: vi.fn(
      async (_name: string, _guestPort: number): Promise<number | null> => null,
    ),
  } satisfies MachineRuntime;
}

type FakeRuntime = ReturnType<typeof fakeRuntime>;

/** Assert no runtime method was called. */
function expectUntouched(runtime: FakeRuntime) {
  for (const [name, method] of Object.entries(runtime)) {
    expect(method, name).not.toHaveBeenCalled();
  }
}

function harness(runtime = fakeRuntime()) {
  return {
    app: authenticated(createApp({ secretKey: SECRET }, runtime)),
    runtime,
  };
}

/** Send every request with the daemon's secret, as a legitimate caller would. */
function authenticated(app: ReturnType<typeof createApp>) {
  return {
    request(input: string | Request, init: RequestInit = {}) {
      if (input instanceof Request) {
        input.headers.set("Authorization", `Bearer ${SECRET}`);
        return app.request(input);
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${SECRET}`);
      return app.request(input, { ...init, headers });
    },
  };
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("machine API", () => {
  it("keeps health independent of the runtime", async () => {
    const { app, runtime } = harness();
    expect(await (await app.request("/health")).json()).toEqual({
      status: "ok",
      apis: ["v0beta1"],
    });
    expectUntouched(runtime);
  });

  it("creates without starting, passing resources and environment", async () => {
    const { app, runtime } = harness();
    const input = {
      name: "demo",
      image: "ubuntu:24.04",
      cpus: 2,
      memoryMb: 1536,
      storageGb: 20,
      network: true,
      env: [{ name: "MODE", value: "test" }],
    };
    const response = await app.request(ROOT, json(input));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(MACHINE);
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledWith({
      ...input,
      services: undefined,
    });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  describe("image resolution", () => {
    const CODER = "ghcr.io/gofixpoint/amika-coder:0123456789ab";

    function withImages(configPath?: string) {
      const runtime = fakeRuntime();
      const app = authenticated(
        createApp(
          { secretKey: SECRET, images: { "amika-coder": CODER }, configPath },
          runtime,
        ),
      );
      const forwarded = () => runtime.create.mock.calls[0][0].image;
      return { app, runtime, forwarded };
    }

    it("creates with the configured reference for a preset name", async () => {
      const { app, forwarded } = withImages();
      const input = { name: "demo", image: "amika-coder", cpus: 2 };
      expect((await app.request(ROOT, json(input))).status).toBe(201);
      expect(forwarded()).toBe(CODER);
    });

    it("refuses a name that isn't configured, naming the config file", async () => {
      const { app, runtime } = withImages("/etc/amika-hostd/config.toml");
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "amika-coder-plus-docker" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'image "amika-coder-plus-docker" is not configured on this host; add it under [preset_images] in /etc/amika-hostd/config.toml',
      });
      expectUntouched(runtime);
    });

    it("refuses an unconfigured name when no config file was found", async () => {
      const { app } = harness();
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "amika-coder" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'image "amika-coder" is not configured on this host; add it under [preset_images] in the amika-hostd config.toml',
      });
    });

    it.each(["ubuntu:24.04", "ghcr.io/gofixpoint/amika-coder", CODER])(
      "passes full reference %s unchanged",
      async (image) => {
        const { app, forwarded } = withImages();
        expect(
          (await app.request(ROOT, json({ name: "demo", image }))).status,
        ).toBe(201);
        expect(forwarded()).toBe(image);
      },
    );
  });

  it.each([
    [undefined, true],
    [false, false],
  ])(
    "defaults networking on while honoring network=%s",
    async (network, expected) => {
      const { app, runtime } = harness();
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "ubuntu:24.04", network }),
      );
      expect(response.status).toBe(201);
      expect(runtime.create.mock.calls[0][0].network).toBe(expected);
    },
  );

  it.each([
    ["GET", "", "list", 200, { machines: [MACHINE] }],
    ["GET", "/demo", "get", 200, MACHINE],
    ["POST", "/demo/start", "start", 200, { ...MACHINE, state: "running" }],
    ["POST", "/demo/stop", "stop", 200, MACHINE],
    ["DELETE", "/demo", "remove", 204, null],
  ] as const)(
    "routes %s %s to runtime.%s alone",
    async (method, path, call, status, body) => {
      const { app, runtime } = harness();
      const response = await app.request(`${ROOT}${path}`, { method });
      expect(response.status).toBe(status);
      if (body === null) expect(await response.text()).toBe("");
      else expect(await response.json()).toEqual(body);
      for (const [name, fn] of Object.entries(runtime)) {
        expect(fn, name).toHaveBeenCalledTimes(name === call ? 1 : 0);
      }
      if (call !== "list") {
        expect(runtime[call]).toHaveBeenCalledWith("demo");
      }
    },
  );

  it("passes exec argv, stdin, cwd, and environment separately and retains exit codes", async () => {
    const result = { exitCode: 7, stdout: "output", stderr: "failure" };
    const { app, runtime } = harness();
    runtime.exec.mockResolvedValueOnce(result);
    const input = {
      command: ["/bin/sh", "-c", "cat"],
      stdin: "input",
      user: "root",
      workdir: "/workspace",
      env: [{ name: "A", value: "a b" }],
    };
    expect(
      await (await app.request(`${ROOT}/demo/exec`, json(input))).json(),
    ).toEqual(result);
    expect(runtime.exec).toHaveBeenCalledWith("demo", input);
  });

  it("round trips binary files and encoded filenames", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const { app, runtime } = harness();
    const path = `${ROOT}/files/files/workspace/a%20%23%3F%25.bin`;
    expect(
      (await app.request(path, { method: "PUT", body: bytes })).status,
    ).toBe(204);
    // The machine is named `files`; the guest path is decoded and absolute.
    expect(runtime.writeFile).toHaveBeenCalledWith(
      "files",
      "/workspace/a #?%.bin",
      bytes,
    );
    runtime.readFile.mockResolvedValueOnce({
      body: new Response(bytes).body,
      contentType: "application/octet-stream",
    });
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(runtime.readFile).toHaveBeenCalledWith(
      "files",
      "/workspace/a #?%.bin",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("accepts smolvm's minimum memory", async () => {
    const { app, runtime } = harness();
    const input = { name: "demo", image: "ubuntu:24.04", memoryMb: 64 };
    expect((await app.request(ROOT, json(input))).status).toBe(201);
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { name: "../bad", image: "ubuntu" },
    { name: "demo", image: " " },
    { name: "demo", image: "ubuntu", cpus: 0 },
    { name: "demo", image: "ubuntu", cpus: 17 },
    { name: "demo", image: "ubuntu", memoryMb: 1.5 },
    { name: "demo", image: "ubuntu", memoryMb: 63 },
    { name: "demo", image: "ubuntu", hostMounts: ["/"] },
  ])(
    "rejects invalid create input without calling the runtime: %j",
    async (input) => {
      const { app, runtime } = harness();
      expect((await app.request(ROOT, json(input))).status).toBe(400);
      expectUntouched(runtime);
    },
  );

  it.each([
    { command: [] },
    { command: "echo bad" },
    { command: ["pwd"], workdir: "relative" },
  ])("rejects invalid exec input: %j", async (input) => {
    const { app, runtime } = harness();
    expect((await app.request(`${ROOT}/demo/exec`, json(input))).status).toBe(
      400,
    );
    expectUntouched(runtime);
  });

  it("rejects malformed JSON without echoing input", async () => {
    const { app, runtime } = harness();
    const response = await app.request(ROOT, {
      method: "POST",
      body: "secret",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret");
    expectUntouched(runtime);
  });

  it.each([
    "/bad%2Fname",
    "/demo/files/a%2F..%2Fsecret",
    "/demo/files/%00",
    "/demo/files/%ZZ",
  ])("rejects invalid names and file paths: %s", async (path) => {
    const { app, runtime } = harness();
    expect((await app.request(`${ROOT}${path}`)).status).toBe(400);
    expectUntouched(runtime);
  });

  it.each([400, 404, 409, 422, 500, 503])(
    "preserves runtime status %i without leaking its message",
    async (status) => {
      const { app, runtime } = harness();
      runtime.get.mockRejectedValueOnce(
        new RuntimeError(status, "sensitive command contents"),
      );
      const response = await app.request(`${ROOT}/demo`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Smol runtime request failed",
      });
    },
  );

  it("answers 500 for an unexpected runtime failure without leaking it", async () => {
    const { app, runtime } = harness();
    runtime.list.mockRejectedValueOnce(new Error("private engine details"));
    const response = await app.request(ROOT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Smol runtime request failed",
    });
  });

  it("returns 504 when the runtime deadline expires", async () => {
    const runtime = fakeRuntime();
    runtime.list.mockReturnValueOnce(new Promise(() => {}));
    const app = authenticated(
      createApp({ secretKey: SECRET, requestTimeoutMs: 5 }, runtime),
    );
    const response = await app.request(ROOT);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Smol runtime request timed out",
    });
  });

  it("ignores a runtime call that fails after the deadline", async () => {
    const runtime = fakeRuntime();
    let fail: (error: Error) => void = () => {};
    runtime.list.mockReturnValueOnce(
      new Promise((_resolve, reject) => (fail = reject)),
    );
    const app = authenticated(
      createApp({ secretKey: SECRET, requestTimeoutMs: 5 }, runtime),
    );
    expect((await app.request(ROOT)).status).toBe(504);
    // An unhandled rejection here would fail the test run.
    fail(new RuntimeError(500, "late"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it.each([0, -1, 1.5])(
    "refuses a request timeout of %s",
    (requestTimeoutMs) => {
      expect(() =>
        createApp({ secretKey: SECRET, requestTimeoutMs }, fakeRuntime()),
      ).toThrow();
    },
  );

  it.each([
    ["POST", ROOT],
    ["POST", `${ROOT}/demo/exec`],
    ["PUT", `${ROOT}/demo/files/large.bin`],
  ])(
    "rejects oversized %s %s before calling the runtime",
    async (method, path) => {
      const { app, runtime } = harness();
      const response = await app.request(path, {
        method,
        headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
        body: "a",
      });
      expect(response.status).toBe(413);
      expectUntouched(runtime);
    },
  );

  it("limits streamed create bodies without Content-Length before JSON parsing", async () => {
    const { app, runtime } = harness();
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 65; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const init = { method: "POST", body, duplex: "half" as const };
    const response = await app.request(
      new Request(`http://localhost${ROOT}`, init),
    );
    expect(response.status).toBe(413);
    expectUntouched(runtime);
  });

  it("does not expose other runtime endpoints", async () => {
    const { app, runtime } = harness();
    expect(
      (await app.request(`${ROOT}/demo/exec/stream`, json({}))).status,
    ).toBe(404);
    expectUntouched(runtime);
  });
});

describe("secret key authentication", () => {
  function unauthenticated() {
    const runtime = fakeRuntime();
    return { app: createApp({ secretKey: SECRET }, runtime), runtime };
  }

  it.each([
    ["missing", undefined],
    ["wrong", `Bearer not-${SECRET}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret in another scheme", `Basic ${SECRET}`],
    ["an empty bearer token", "Bearer "],
  ])("rejects a %s credential on every route", async (_label, header) => {
    const { app, runtime } = unauthenticated();
    const headers: Record<string, string> = header
      ? { Authorization: header }
      : {};
    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", ROOT],
      ["POST", `${ROOT}/demo/start`],
      ["GET", "/not-a-route"],
    ]) {
      const response = await app.request(path, { method, headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expectUntouched(runtime);
  });

  it("rejects before enforcing the body limit", async () => {
    const { app, runtime } = unauthenticated();
    const response = await app.request(ROOT, {
      method: "POST",
      headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
      body: "a",
    });
    expect(response.status).toBe(401);
    expectUntouched(runtime);
  });

  it.each([
    ["a lowercase scheme", `bearer ${SECRET}`],
    ["extra whitespace", `Bearer \t ${SECRET}  `],
    ["no scheme", SECRET],
  ])("accepts the secret with %s", async (_label, header) => {
    const { app } = unauthenticated();
    const response = await app.request("/health", {
      headers: { Authorization: header },
    });
    expect(response.status).toBe(200);
  });

  it("matches the secret exactly", async () => {
    const { app } = unauthenticated();
    const wrongCase = await app.request("/health", {
      headers: { Authorization: `Bearer ${SECRET.toUpperCase()}` },
    });
    expect(wrongCase.status).toBe(401);
  });
});

describe("API versions", () => {
  it.each(["/v0beta1/rigs", "/api/v1/machines"])(
    "serves the machine API at %s",
    async (prefix) => {
      const { app, runtime } = harness();
      const create = await app.request(
        prefix,
        json({ name: "demo", image: "ubuntu:24.04" }),
      );
      expect(create.status).toBe(201);
      expect((await app.request(`${prefix}/demo`)).status).toBe(200);
      expect(
        (await app.request(`${prefix}/demo/start`, { method: "POST" })).status,
      ).toBe(200);
      expect(
        (await app.request(`${prefix}/demo/files/work%20dir/a.txt`)).status,
      ).toBe(200);
      expect(
        (
          await app.request(`${prefix}/demo/files/b.txt`, {
            method: "PUT",
            body: "hi",
          })
        ).status,
      ).toBe(204);
      expect(runtime.create.mock.calls[0][0].name).toBe("demo");
      expect(runtime.get).toHaveBeenCalledWith("demo");
      expect(runtime.start).toHaveBeenCalledWith("demo");
      expect(runtime.readFile).toHaveBeenCalledWith("demo", "/work dir/a.txt");
      expect(runtime.writeFile).toHaveBeenCalledWith(
        "demo",
        "/b.txt",
        new TextEncoder().encode("hi"),
      );
    },
  );

  it("serves service routes only at the versioned path", async () => {
    const { app, runtime } = harness();
    const response = await app.request("/rigs/demo/services/web/", {
      headers: { "X-Amika-Hostd-Key": SECRET },
    });
    expect(response.status).toBe(404);
    expectUntouched(runtime);
  });
});

describe("services at create", () => {
  function creating() {
    const runtime = fakeRuntime();
    const registry = memoryServiceRegistry();
    const app = authenticated(
      createApp({ secretKey: SECRET }, runtime, { registry }),
    );
    return { app, runtime, registry };
  }

  it("hands the services to the runtime and records every name", async () => {
    const { app, runtime, registry } = creating();
    const input = {
      name: "demo",
      image: "ubuntu:24.04",
      services: [
        { name: "web", port: 3000 },
        { name: "web-alias", port: 3000 },
        { name: "amikad", port: 60999 },
      ],
    };
    expect((await app.request(ROOT, json(input))).status).toBe(201);
    // The runtime publishes each guest port and picks its host side.
    expect(runtime.create.mock.calls[0][0].services).toEqual(input.services);
    expect(registry.port("demo", "web")).toBe(3000);
    expect(registry.port("demo", "web-alias")).toBe(3000);
    expect(registry.port("demo", "amikad")).toBe(60999);
  });

  it("records nothing when the runtime refuses the machine", async () => {
    const { app, runtime, registry } = creating();
    runtime.create.mockRejectedValueOnce(new RuntimeError(409, "exists"));
    const input = {
      name: "demo",
      image: "ubuntu:24.04",
      services: [{ name: "web", port: 3000 }],
    };
    expect((await app.request(ROOT, json(input))).status).toBe(409);
    expect(registry.port("demo", "web")).toBeUndefined();
  });

  it("forgets a deleted machine's services", async () => {
    const { app, registry } = creating();
    registry.set("demo", { web: 3000 });
    expect(
      (await app.request(`${ROOT}/demo`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(registry.port("demo", "web")).toBeUndefined();
  });

  it("forgets the services of a machine the runtime no longer has", async () => {
    const { app, runtime, registry } = creating();
    registry.set("demo", { web: 3000 });
    runtime.remove.mockRejectedValueOnce(new RuntimeError(404, "gone"));
    expect(
      (await app.request(`${ROOT}/demo`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(registry.port("demo", "web")).toBeUndefined();
  });

  it("keeps the services when a delete fails otherwise", async () => {
    const { app, runtime, registry } = creating();
    registry.set("demo", { web: 3000 });
    runtime.remove.mockRejectedValueOnce(new RuntimeError(409, "busy"));
    expect(
      (await app.request(`${ROOT}/demo`, { method: "DELETE" })).status,
    ).toBe(409);
    expect(registry.port("demo", "web")).toBe(3000);
  });

  it.each([
    [
      [
        { name: "web", port: 3000 },
        { name: "web", port: 3001 },
      ],
    ],
    [[{ name: "web", port: 0 }]],
    [[{ name: "", port: 3000 }]],
    [[{ name: ".", port: 3000 }]],
    [[{ name: "..", port: 3000 }]],
    [[{ name: "x".repeat(301), port: 3000 }]],
    [[{ name: "web", port: 3000, host: 22 }]],
    [Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, port: 3000 + i }))],
  ])(
    "rejects invalid services without calling the runtime: %j",
    async (services) => {
      const { app, runtime } = harness();
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "ubuntu:24.04", services }),
      );
      expect(response.status).toBe(400);
      expectUntouched(runtime);
    },
  );
});

describe("replacing a machine's services", () => {
  function replacing() {
    const runtime = fakeRuntime();
    const registry = memoryServiceRegistry();
    registry.set("demo", { web: 3000, amikad: 60999 });
    const app = authenticated(
      createApp({ secretKey: SECRET }, runtime, { registry }),
    );
    const put = (services: unknown) =>
      app.request(`${ROOT}/demo/services`, {
        ...json({ services }),
        method: "PUT",
      });
    return { put, registry, runtime };
  }

  it("renames, adds and removes names on published ports", async () => {
    const { put, registry, runtime } = replacing();
    const response = await put([
      { name: "site", port: 3000 },
      { name: "site-admin", port: 3000 },
    ]);
    expect(response.status).toBe(204);
    expect(runtime.checkServices).toHaveBeenCalledWith("demo", [
      { name: "site", port: 3000 },
      { name: "site-admin", port: 3000 },
    ]);
    expect(registry.port("demo", "site")).toBe(3000);
    expect(registry.port("demo", "site-admin")).toBe(3000);
    expect(registry.port("demo", "web")).toBeUndefined();
    expect(registry.port("demo", "amikad")).toBeUndefined();
  });

  it("refuses a port the machine did not publish, keeping the old names", async () => {
    const { put, registry, runtime } = replacing();
    const message = "machine demo does not publish 4000";
    runtime.checkServices.mockRejectedValueOnce(new RuntimeError(409, message));
    const response = await put([{ name: "api", port: 4000 }]);
    expect(response.status).toBe(409);
    // The refusal's message is passed on: it names ports, nothing secret.
    expect(await response.json()).toEqual({ error: message });
    expect(registry.port("demo", "web")).toBe(3000);
    expect(registry.port("demo", "api")).toBeUndefined();
  });

  it("passes on the runtime's 404 for an unknown machine", async () => {
    const { put, registry, runtime } = replacing();
    runtime.checkServices.mockRejectedValueOnce(new RuntimeError(404, "nope"));
    const response = await put([{ name: "site", port: 3000 }]);
    expect(response.status).toBe(404);
    // Only a 409's message is passed on.
    expect(await response.json()).toEqual({
      error: "Smol runtime request failed",
    });
    expect(registry.port("demo", "web")).toBe(3000);
  });

  it("validates the services before calling the runtime", async () => {
    const { put, runtime } = replacing();
    expect((await put([{ name: "..", port: 3000 }])).status).toBe(400);
    expectUntouched(runtime);
  });

  it("requires the bearer secret like the rest of the machine API", async () => {
    const runtime = fakeRuntime();
    const app = createApp({ secretKey: SECRET }, runtime);
    const response = await app.request(`${ROOT}/demo/services`, {
      method: "PUT",
      headers: {
        "X-Amika-Hostd-Key": SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ services: [] }),
    });
    expect(response.status).toBe(401);
    expectUntouched(runtime);
  });
});

describe("service routes", () => {
  const HOST_PORT = 41001;
  const ROUTE = "/v0beta1/rigs/demo/services/amikad";

  /**
   * The host port the runtime reports for the service (null for a machine
   * that is stopped, missing, or did not publish it), and the guest's
   * answers to forwarded requests, in order.
   */
  function services(
    hostPort: number | null = HOST_PORT,
    ...responses: (Response | Error)[]
  ) {
    const runtime = fakeRuntime();
    runtime.hostPort.mockResolvedValue(hostPort);
    const fetcher = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      if (response instanceof Error) throw response;
      return response;
    });
    const registry = memoryServiceRegistry();
    registry.set("demo", { amikad: 60999, web: 3000 });
    const app = createApp({ secretKey: SECRET }, runtime, {
      registry,
      fetch: fetcher,
    });
    return {
      app,
      runtime,
      fetcher,
      request: (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("X-Amika-Hostd-Key", SECRET);
        return app.request(path, { ...init, headers });
      },
    };
  }

  it("forwards the guest path, query, body and the guest's credential", async () => {
    const { request, runtime, fetcher } = services(
      HOST_PORT,
      new Response("created", {
        status: 201,
        headers: {
          "X-Guest": "yes",
          Connection: "keep-alive, X-Guest-Hop",
          "X-Guest-Hop": "per-connection",
        },
      }),
    );
    const response = await request(`${ROUTE}/v1/items?limit=2`, {
      method: "POST",
      headers: {
        Authorization: "Bearer connect-token",
        "Proxy-Authorization": "Basic x",
        Connection: "X-Hop",
        "X-Hop": "per-connection",
        "Content-Type": "text/plain",
      },
      body: "payload",
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
    expect(response.headers.get("x-guest")).toBe("yes");
    expect(response.headers.get("x-guest-hop")).toBeNull();
    expect(runtime.hostPort).toHaveBeenCalledWith("demo", 60999);
    const [[target, init]] = fetcher.mock.calls;
    expect(target).toBe("http://127.0.0.1:41001/v1/items?limit=2");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer connect-token");
    // The host key never reaches the guest.
    expect(headers.get("x-amika-hostd-key")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-hop")).toBeNull();
    expect(await new Response(init?.body).text()).toBe("payload");
  });

  it("forwards the route root as the guest root", async () => {
    const { request, fetcher } = services(HOST_PORT, new Response("ok"));
    expect((await request(ROUTE)).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:41001/");
  });

  it.each([
    ["no key", {}],
    ["a wrong key", { "X-Amika-Hostd-Key": `not-${SECRET}` }],
    ["the key only in Authorization", { Authorization: `Bearer ${SECRET}` }],
  ])(
    "returns 401 for %s without touching the runtime",
    async (_label, headers) => {
      const { app, runtime, fetcher } = services();
      const response = await app.request(`${ROUTE}/x`, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("connection")).toBe("close");
      expectUntouched(runtime);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("requires the key for plain HTTP to amikad's SSH path", async () => {
    // Only the WebSocket upgrade there skips the key (see services.ts).
    const { app, runtime, fetcher } = services();
    const response = await app.request(
      "/v0beta1/rigs/demo/services/amikad/v1/ssh-sessions",
      { headers: { Authorization: "Bearer connect-token" } },
    );
    expect(response.status).toBe(401);
    expectUntouched(runtime);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to forward the host key as the guest's Authorization", async () => {
    const { request, runtime, fetcher } = services();
    const response = await request(ROUTE, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(400);
    expectUntouched(runtime);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown service", "/v0beta1/rigs/demo/services/nope"],
    ["an unknown machine", "/v0beta1/rigs/other/services/amikad"],
  ])(
    "returns 404 without touching the runtime for %s",
    async (_label, path) => {
      const { request, runtime, fetcher } = services();
      expect((await request(path)).status).toBe(404);
      expectUntouched(runtime);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an invalid machine name", "/v0beta1/rigs/-demo/services/amikad"],
    ["an unversioned service path", "/rigs/demo/services/amikad"],
    ["a machine route", "/v0beta1/rigs/demo"],
  ])(
    "treats %s as the machine API, which wants the bearer secret",
    async (_label, path) => {
      const { request, runtime, fetcher } = services();
      expect((await request(path)).status).toBe(401);
      expectUntouched(runtime);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the runtime reports no host port", async () => {
    // A machine that is stopped, missing, or did not publish the port.
    const { request, runtime, fetcher } = services(null);
    expect((await request(ROUTE)).status).toBe(404);
    expect(runtime.hostPort).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns 502 when the guest port refuses the connection", async () => {
    const { request } = services(HOST_PORT, new TypeError("fetch failed"));
    const response = await request(ROUTE);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
  });

  it("keeps requiring the bearer secret everywhere else", async () => {
    const { request, runtime, fetcher } = services();
    // The service-route header does not unlock the machine API.
    expect((await request(`${ROOT}/demo`)).status).toBe(401);
    expectUntouched(runtime);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
