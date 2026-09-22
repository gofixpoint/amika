/** Contract tests against smolvm serve's camelCase HTTP API. */
import { describe, expect, it, vi } from "vitest";
import type { CreateSandboxProviderInput } from "../../provider";
import { SmolClient } from "./client";
import { mapSmolState, smolOperations } from "./operations";

const INPUT: CreateSandboxProviderInput = {
  name: "local-test",
  snapshot: "ubuntu:24.04",
  services: [],
};
const MACHINE = {
  name: INPUT.name,
  state: "stopped",
  cpus: 2,
  memoryMb: 1536,
  storageGb: 20,
};

function harness(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  });
  const config = { network: true };
  return {
    fetcher,
    ops: smolOperations(config, new SmolClient(config, fetcher)),
  };
}
function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}
function body(fetcher: ReturnType<typeof harness>["fetcher"], index: number) {
  return JSON.parse(String(fetcher.mock.calls[index][1]?.body));
}

describe("smol operations", () => {
  it("creates and starts an image machine with resources and environment", async () => {
    const { ops, fetcher } = harness([
      json(MACHINE),
      json({ ...MACHINE, state: "running" }),
    ]);
    expect(
      await ops.create({
        ...INPUT,
        resources: { vcpus: 2, memoryGib: 1.5, diskGib: 20 },
        envVars: { MODE: "local" },
      }),
    ).toEqual({
      provider: "smol",
      providerSandboxId: INPUT.name,
      services: [],
      envVars: { MODE: "local" },
    });
    expect(
      fetcher.mock.calls.map(([url, opts]) => [url, opts?.method]),
    ).toEqual([
      ["http://127.0.0.1:8080/api/v1/machines", "POST"],
      ["http://127.0.0.1:8080/api/v1/machines/local-test/start", "POST"],
    ]);
    expect(body(fetcher, 0)).toEqual({
      name: INPUT.name,
      image: INPUT.snapshot,
      cpus: 2,
      memoryMb: 1536,
      storageGb: 20,
      network: true,
      env: [{ name: "MODE", value: "local" }],
    });
  });

  it("cleans up a machine when starting fails", async () => {
    const { ops, fetcher } = harness([json(MACHINE), json({}, 500), json({})]);
    await expect(ops.create(INPUT)).rejects.toThrow("HTTP 500");
    expect(fetcher.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("retains both errors when cleanup fails", async () => {
    const { ops } = harness([json(MACHINE), json({}, 500), json({}, 503)]);
    await expect(ops.create(INPUT)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ status: 500 }),
        expect.objectContaining({ status: 503 }),
      ],
    });
  });

  it("never deletes an existing machine after a create conflict", async () => {
    const { ops, fetcher } = harness([json({}, 409)]);
    await expect(ops.create(INPUT)).rejects.toThrow("HTTP 409");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { autoStopInterval: 1 },
    { autoDeleteInterval: 60 },
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
    { snapshot: "" },
    { name: "../another-machine" },
    { resources: { vcpus: 0, memoryGib: 1, diskGib: 20 } },
  ])(
    "rejects unsupported or invalid create input before allocating: %j",
    async (input) => {
      const { ops, fetcher } = harness([]);
      await expect(ops.create({ ...INPUT, ...input })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reads stopped state without starting a machine", async () => {
    const { ops, fetcher } = harness([json(MACHINE)]);
    expect(await ops.getState(INPUT.name)).toBe("stopped");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(mapSmolState("stopped")).toBe("suspended");
    expect(mapSmolState("new-state")).toBe("unknown");
  });

  it("treats missing state and delete as absent, but propagates server failures", async () => {
    const { ops } = harness([json({}, 404), json({}, 404), json({}, 503)]);
    expect(await ops.getState(INPUT.name)).toBe("unknown");
    await ops.remove(INPUT.name);
    await expect(ops.remove(INPUT.name)).rejects.toThrow("HTTP 503");
  });

  it("transports shell commands and stdin separately and preserves nonzero exits", async () => {
    const result = { exitCode: 7, stdout: "out", stderr: "err" };
    const { ops, fetcher } = harness([json(result)]);
    expect(
      await ops.run(INPUT.name, 'cat; printf "$VALUE"', {
        input: "secret",
        cwd: "/workspace",
        env: { VALUE: "a b" },
        sudo: true,
      }),
    ).toEqual(result);
    expect(body(fetcher, 0)).toEqual({
      command: ["/bin/sh", "-c", 'cat; printf "$VALUE"'],
      user: "root",
      workdir: "/workspace",
      env: [{ name: "VALUE", value: "a b" }],
      stdin: "secret",
    });
  });

  it("uploads binary bytes and reads UTF-8 through the provisioning adapter", async () => {
    const { ops, fetcher } = harness([
      json({}),
      new Response("hello", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    ]);
    const adapter = ops.adapter(INPUT.name);
    const content = Buffer.from([0, 255, 128]);
    await adapter.uploadFile(content, "/workspace/a #?.bin");
    expect(fetcher.mock.calls[0][0]).toContain(
      "/files/workspace/a%20%23%3F.bin",
    );
    expect(fetcher.mock.calls[0][1]?.body).toEqual(new Uint8Array(content));
    expect(await adapter.downloadFile("/workspace/a.txt")).toBe("hello");
  });

  it("returns null only for missing files and rejects directory responses", async () => {
    const { ops } = harness([
      json({}, 404),
      json({}, 500),
      json({ entries: [] }),
    ]);
    expect(await ops.read(INPUT.name, "/missing")).toBeNull();
    await expect(ops.read(INPUT.name, "/broken")).rejects.toThrow("HTTP 500");
    await expect(ops.read(INPUT.name, "/directory")).rejects.toThrow(
      "directory",
    );
  });

  it("rejects path traversal before sending file requests", async () => {
    const { ops, fetcher } = harness([]);
    await expect(ops.read(INPUT.name, "/../../exec")).rejects.toThrow(
      "dot segments",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists known sizing and omits machines without disk sizing", async () => {
    const { ops } = harness([
      json({
        machines: [MACHINE, { ...MACHINE, name: "old", storageGb: undefined }],
      }),
    ]);
    expect(await ops.list()).toEqual([
      {
        providerSandboxId: INPUT.name,
        state: "stopped",
        orgId: null,
        sizing: { vcpus: 2, memoryGib: 1.5, diskGib: 20 },
      },
    ]);
  });

  it("rejects malformed API output", async () => {
    const { ops } = harness([json({ exitCode: "0", stdout: "", stderr: "" })]);
    await expect(ops.run(INPUT.name, "true")).rejects.toThrow();
  });
});
