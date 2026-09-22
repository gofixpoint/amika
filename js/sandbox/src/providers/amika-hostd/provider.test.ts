/** Exercise sandbox resources through the real hostd routes and a fake runtime. */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../../amika-hostd/src/app";
import { moduleLogger, type SandboxCtx } from "../../logger";
import { getProviderLabel, isSandboxProviderName } from "../capabilities";
import { type CreateSandboxProviderInput } from "../provider";
import amikaHostdProvider, { openAmikaHostdAdapter } from "./provider";

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
const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

function harness(responses: Response[]) {
  const runtime = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected runtime request");
    return response;
  });
  const app = createApp({}, runtime);
  const fetcher = vi.fn<typeof fetch>(async (url, init) =>
    app.request(new Request(url, init)),
  );
  const config = { network: true };
  return {
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
      "http://127.0.0.1:3020/api/v1/machines",
      "http://127.0.0.1:3020/api/v1/machines/demo/start",
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
    {
      services: [
        {
          name: "web",
          url: "",
          hostPort: 3000,
          containerPort: 3000,
          protocol: "tcp" as const,
        },
      ],
    },
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
      lifecycle: false,
      exec: true,
      listSandboxes: true,
      ssh: false,
      services: false,
      snapshots: false,
      streaming: false,
      supportsAutoDelete: false,
    });
    const sandbox = provider.sandboxes.get("demo");
    expect(sandbox.ssh).toBeNull();
    expect(sandbox.services).toBeNull();
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

  it("honors a custom hostd URL without authentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(MACHINE));
    const provider = amikaHostdProvider({
      config: { apiUrl: "http://host:4000/", requestTimeoutMs: 1234 },
      fetcher,
    });
    expect(await provider.sandboxes.get("demo").getState()).toBe("stopped");
    expect(fetcher).toHaveBeenCalledWith(
      "http://host:4000/api/v1/machines/demo",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: undefined,
      }),
    );
  });
});
