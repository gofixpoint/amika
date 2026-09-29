/** Exercise the daemon's HTTP boundary with an injected runtime transport. */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { GuestForwarder } from "./internal/forward.js";
import { signServiceToken } from "./internal/services.js";

const ROOT = "/api/v1/machines";
const SECRET = "test-secret";

function harness(response = Response.json({ name: "demo", state: "stopped" })) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    app: authenticated(
      createApp({ secretKey: SECRET, apiUrl: "http://runtime:8080" }, fetcher),
    ),
    fetcher,
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
    const { app, fetcher } = harness();
    expect(await (await app.request("/health")).json()).toEqual({
      status: "ok",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates without starting, forwarding resources and environment", async () => {
    const { app, fetcher } = harness(
      Response.json({ name: "demo" }, { status: 201 }),
    );
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
    expect(await response.json()).toEqual({ name: "demo" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `http://runtime:8080${ROOT}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  describe("image resolution", () => {
    const CODER = "ghcr.io/gofixpoint/amika-coder:0123456789ab";

    function withImages(configPath?: string) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ name: "demo" }, { status: 201 }));
      const app = authenticated(
        createApp(
          {
            secretKey: SECRET,
            apiUrl: "http://runtime:8080",
            images: { "amika-coder": CODER },
            configPath,
          },
          fetcher,
        ),
      );
      const forwarded = () =>
        JSON.parse(String(fetcher.mock.calls[0][1]?.body)).image;
      return { app, fetcher, forwarded };
    }

    it("forwards the configured reference for a preset name", async () => {
      const { app, forwarded } = withImages();
      const input = { name: "demo", image: "amika-coder", cpus: 2 };
      expect((await app.request(ROOT, json(input))).status).toBe(201);
      expect(forwarded()).toBe(CODER);
    });

    it("refuses a name that isn't configured, naming the config file", async () => {
      const { app, fetcher } = withImages("/etc/amika-hostd/config.toml");
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "amika-coder-plus-docker" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'image "amika-coder-plus-docker" is not configured on this host; add it under [images] in /etc/amika-hostd/config.toml',
      });
      expect(fetcher).not.toHaveBeenCalled();
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
          'image "amika-coder" is not configured on this host; add it under [images] in the amika-hostd config.toml',
      });
    });

    it.each(["ubuntu:24.04", "ghcr.io/gofixpoint/amika-coder", CODER])(
      "forwards full reference %s unchanged",
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
      const { app, fetcher } = harness();
      const response = await app.request(
        ROOT,
        json({ name: "demo", image: "ubuntu:24.04", network }),
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).network).toBe(
        expected,
      );
    },
  );

  it.each([
    ["GET", ""],
    ["GET", "/demo"],
    ["POST", "/demo/start"],
    ["POST", "/demo/stop"],
    ["DELETE", "/demo"],
  ])(
    "routes %s %s without additional lifecycle calls",
    async (method, path) => {
      const { app, fetcher } = harness();
      expect((await app.request(`${ROOT}${path}`, { method })).status).toBe(
        200,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(
        `http://runtime:8080${ROOT}${path}`,
        expect.objectContaining({ method, body: undefined }),
      );
    },
  );

  it("passes exec argv, stdin, cwd, and environment separately and retains exit codes", async () => {
    const result = { exitCode: 7, stdout: "output", stderr: "failure" };
    const { app, fetcher } = harness(Response.json(result));
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
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
  });

  it("round trips binary files and encoded filenames", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const { app, fetcher } = harness(new Response(null, { status: 204 }));
    const path = `${ROOT}/files/files/workspace/a%20%23%3F%25.bin`;
    expect(
      (await app.request(path, { method: "PUT", body: bytes })).status,
    ).toBe(204);
    expect(fetcher).toHaveBeenCalledWith(
      `http://runtime:8080${path}`,
      expect.objectContaining({
        method: "PUT",
        body: Buffer.from(bytes),
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    fetcher.mockResolvedValueOnce(
      new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Set-Cookie": "private=value",
        },
      }),
    );
    const response = await app.request(path);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("accepts smolvm's minimum memory", async () => {
    const { app, fetcher } = harness(
      Response.json({ name: "demo" }, { status: 201 }),
    );
    const input = { name: "demo", image: "ubuntu:24.04", memoryMb: 64 };
    expect((await app.request(ROOT, json(input))).status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    "rejects invalid create input without contacting the runtime: %j",
    async (input) => {
      const { app, fetcher } = harness();
      expect((await app.request(ROOT, json(input))).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { command: [] },
    { command: "echo bad" },
    { command: ["pwd"], workdir: "relative" },
  ])("rejects invalid exec input: %j", async (input) => {
    const { app, fetcher } = harness();
    expect((await app.request(`${ROOT}/demo/exec`, json(input))).status).toBe(
      400,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without echoing input", async () => {
    const { app, fetcher } = harness();
    const response = await app.request(ROOT, {
      method: "POST",
      body: "secret",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "/bad%2Fname",
    "/demo/files/a%2F..%2Fsecret",
    "/demo/files/%00",
    "/demo/files/%ZZ",
  ])("rejects invalid names and file paths: %s", async (path) => {
    const { app, fetcher } = harness();
    expect((await app.request(`${ROOT}${path}`)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 404, 409, 422, 500, 503])(
    "preserves runtime HTTP %i without leaking its body",
    async (status) => {
      const { app } = harness(
        new Response("sensitive command contents", { status }),
      );
      const response = await app.request(`${ROOT}/demo`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Smol runtime request failed",
      });
    },
  );

  it("returns 502 on transport failure", async () => {
    const { app, fetcher } = harness();
    fetcher.mockRejectedValueOnce(new Error("private connection details"));
    const response = await app.request(ROOT);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Smol runtime unavailable",
    });
  });

  it("returns 504 when the runtime deadline expires", async () => {
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    const app = authenticated(
      createApp({ secretKey: SECRET, requestTimeoutMs: 5 }, fetcher),
    );
    expect((await app.request(ROOT)).status).toBe(504);
  });

  it.each([
    ["POST", ROOT],
    ["POST", `${ROOT}/demo/exec`],
    ["PUT", `${ROOT}/demo/files/large.bin`],
  ])(
    "rejects oversized %s %s before contacting the runtime",
    async (method, path) => {
      const { app, fetcher } = harness();
      const response = await app.request(path, {
        method,
        headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
        body: "a",
      });
      expect(response.status).toBe(413);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("limits streamed create bodies without Content-Length before JSON parsing", async () => {
    const { app, fetcher } = harness();
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
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expose other runtime endpoints", async () => {
    const { app, fetcher } = harness();
    expect(
      (await app.request(`${ROOT}/demo/exec/stream`, json({}))).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "file:///runtime",
    "http://user:password@runtime",
    "http://runtime/?token=secret",
    "http://runtime/#hash",
  ])("rejects invalid runtime URLs: %s", (apiUrl) => {
    expect(() => createApp({ secretKey: SECRET, apiUrl })).toThrow();
  });
});

describe("secret key authentication", () => {
  function unauthenticated() {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    return { app: createApp({ secretKey: SECRET }, fetcher), fetcher };
  }

  it.each([
    ["missing", undefined],
    ["wrong", `Bearer not-${SECRET}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret in another scheme", `Basic ${SECRET}`],
    ["an empty bearer token", "Bearer "],
  ])("rejects a %s credential on every route", async (_label, header) => {
    const { app, fetcher } = unauthenticated();
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
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects before enforcing the body limit", async () => {
    const { app, fetcher } = unauthenticated();
    const response = await app.request(ROOT, {
      method: "POST",
      headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
      body: "a",
    });
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
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

  it("does not forward the caller's credential to the runtime", async () => {
    const { app, fetcher } = harness();
    await app.request(`${ROOT}/demo`);
    const init = fetcher.mock.calls[0][1];
    expect(JSON.stringify(init?.headers ?? {})).not.toContain(SECRET);
  });
});

describe("published ports", () => {
  it("allocates the host side of each requested guest port", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ name: "demo" }, { status: 201 }));
    let next = 41_000;
    const app = authenticated(
      createApp({ secretKey: SECRET, apiUrl: "http://runtime:8080" }, fetcher, {
        allocatePort: async () => ++next,
      }),
    );
    const input = {
      name: "demo",
      image: "ubuntu:24.04",
      ports: [{ guest: 3000 }, { guest: 60999 }],
    };
    expect((await app.request(ROOT, json(input))).status).toBe(201);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).ports).toEqual([
      { host: 41001, guest: 3000 },
      { host: 41002, guest: 60999 },
    ]);
  });

  it.each([
    [[{ guest: 3000 }, { guest: 3000 }]],
    [[{ guest: 0 }]],
    [[{ guest: 3000, host: 22 }]],
    [Array.from({ length: 17 }, (_, i) => ({ guest: 3000 + i }))],
  ])("rejects invalid ports without calling the runtime: %j", async (ports) => {
    const { app, fetcher } = harness();
    const response = await app.request(
      ROOT,
      json({ name: "demo", image: "ubuntu:24.04", ports }),
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("service routes", () => {
  const CREATED_AT = 1_790_000_000;
  const MACHINE = {
    name: "demo",
    state: "running",
    createdAt: CREATED_AT,
    ports: [{ host: 41001, guest: 60999 }],
  };
  const future = () => Math.floor(Date.now() / 1000) + 3600;
  const route = (
    port = 60999,
    expiresAt = future(),
    machine = "demo",
    createdAt = CREATED_AT,
  ) =>
    `/services/${machine}/${port}/${signServiceToken(SECRET, { machine, createdAt, port, expiresAt })}`;

  /** Runtime lookups and guest requests answered in order from one queue. */
  function services(...responses: (Response | Error)[]) {
    const next = async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      if (response instanceof Error) throw response;
      return response;
    };
    const fetcher = vi.fn<typeof fetch>(next);
    const forward = vi.fn<GuestForwarder>(next);
    // No secret key: service routes are for callers that never hold it.
    return {
      app: createApp(
        { secretKey: SECRET, apiUrl: "http://runtime:8080" },
        fetcher,
        { forwardHttp: forward },
      ),
      fetcher,
      forward,
    };
  }

  it("answers 404 for a machine that is not running", async () => {
    const { app, fetcher } = services(
      Response.json({ ...MACHINE, state: "stopped" }),
    );
    const response = await app.request(`${route()}/v1/status`);
    expect(response.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("forwards the guest path, query, body, Host and caller credential", async () => {
    const { app, fetcher, forward } = services(
      Response.json(MACHINE),
      new Response("created", {
        status: 201,
        headers: {
          "X-Guest": "yes",
          "Content-Encoding": "gzip",
          Connection: "keep-alive, X-Guest-Hop",
          "X-Guest-Hop": "per-connection",
        },
      }),
    );
    const response = await app.request(`${route()}/v1/items?limit=2`, {
      method: "POST",
      headers: {
        Host: "hostd.example",
        Authorization: "Bearer guest-token",
        "Proxy-Authorization": "Basic x",
        Connection: "X-Hop",
        "X-Hop": "per-connection",
        "Content-Type": "text/plain",
        // A socket caller always frames its body; an in-process one must say.
        "Content-Length": "7",
      },
      body: "payload",
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
    expect(response.headers.get("x-guest")).toBe("yes");
    // The guest's bytes pass through undecoded, so their encoding stays.
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("x-guest-hop")).toBeNull();
    expect(fetcher.mock.calls.map(([target]) => target)).toEqual([
      `http://runtime:8080${ROOT}/demo`,
    ]);
    const [[hostPort, forwarded]] = forward.mock.calls;
    expect(hostPort).toBe(41001);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.path).toBe("/v1/items?limit=2");
    const headers = forwarded.headers;
    expect(headers.get("host")).toBe("hostd.example");
    expect(headers.get("authorization")).toBe("Bearer guest-token");
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-hop")).toBeNull();
    expect(await new Response(forwarded.body).text()).toBe("payload");
  });

  it("forwards the route root as the guest root", async () => {
    const { app, forward } = services(
      Response.json(MACHINE),
      new Response("ok"),
    );
    expect((await app.request(route())).status).toBe(200);
    expect(forward.mock.calls[0][1].path).toBe("/");
    // Without a Host header, the one the request URL names.
    expect(forward.mock.calls[0][1].headers.get("host")).toBe("localhost");
  });

  it.each([
    ["an expired token", () => route(60999, Math.floor(Date.now() / 1000) - 1)],
    ["another port's token", () => route(3000).replace("/3000/", "/60999/")],
    [
      "another machine's token",
      () => route(60999, future(), "other").replace("/other/", "/demo/"),
    ],
    [
      "another key's token",
      () =>
        `/services/demo/60999/${signServiceToken("other", { machine: "demo", createdAt: CREATED_AT, port: 60999, expiresAt: future() })}`,
    ],
    ["a malformed token", () => "/services/demo/60999/not-a-token"],
    ["an invalid machine name", () => "/services/-demo/60999/x"],
    ["an out of range port", () => "/services/demo/70000/x"],
    ["no token", () => "/services/demo/60999"],
  ])(
    "returns 404 without touching the runtime for %s",
    async (_label, path) => {
      const { app, fetcher } = services();
      const response = await app.request(path());
      expect(response.status).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("returns 404 for a port the machine did not publish", async () => {
    const { app, fetcher } = services(Response.json(MACHINE));
    expect((await app.request(route(3000))).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a machine recreated under the same name", async () => {
    const { app, fetcher } = services(
      Response.json({ ...MACHINE, createdAt: CREATED_AT + 60 }),
    );
    expect((await app.request(route())).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the runtime does not report createdAt", async () => {
    const { createdAt: _, ...legacy } = MACHINE;
    const { app } = services(Response.json(legacy));
    expect((await app.request(route())).status).toBe(404);
  });

  it("returns 404 for a machine the runtime does not know", async () => {
    const { app } = services(Response.json({ error: "nope" }, { status: 404 }));
    expect((await app.request(route())).status).toBe(404);
  });

  it("returns 502 when the guest port refuses the connection", async () => {
    const { app } = services(
      Response.json(MACHINE),
      new Error("connect ECONNREFUSED 127.0.0.1:41001"),
    );
    const response = await app.request(route());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
  });

  it("keeps requiring the secret key everywhere else", async () => {
    const { app, fetcher } = services();
    expect((await app.request("/servicesx/demo")).status).toBe(401);
    expect((await app.request(`${ROOT}/demo`)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
