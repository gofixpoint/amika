/** Exercise the daemon's HTTP boundary with an injected runtime transport. */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const ROOT = "/api/v1/machines";

function harness(response = Response.json({ name: "demo", state: "stopped" })) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    app: createApp({ apiUrl: "http://runtime:8080" }, fetcher),
    fetcher,
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

  it.each([
    {},
    { name: "../bad", image: "ubuntu" },
    { name: "demo", image: " " },
    { name: "demo", image: "ubuntu", cpus: 0 },
    { name: "demo", image: "ubuntu", memoryMb: 1.5 },
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
    const app = createApp({ requestTimeoutMs: 5 }, fetcher);
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
    expect(() => createApp({ apiUrl })).toThrow();
  });
});
