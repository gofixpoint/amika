/** Contract tests against smolvm serve's camelCase HTTP API. */
import { describe, expect, it, vi } from "vitest";
import type { CreateSandboxProviderInput } from "../../provider";
import { SmolClient } from "./client";
import { SandboxProviderUnsupportedError } from "../../provider";
import type { SandboxService } from "../../../types";
import { SmolPortsError, mapSmolState, smolOperations } from "./operations";

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

function service(name: string, containerPort: number): SandboxService {
  return { name, url: "", hostPort: 0, containerPort, protocol: "tcp" };
}

describe("smol services", () => {
  it("publishes each service's guest port once, on host ports it picks", async () => {
    const { ops, fetcher } = harness([
      json(MACHINE),
      json({ ...MACHINE, state: "running" }),
    ]);
    const created = await ops.create({
      ...INPUT,
      services: [
        service("web", 3000),
        service("web-alias", 3000),
        { ...service("amikad", 60999), urlScheme: "https" },
      ],
    });
    const { ports, services } = body(fetcher, 0);
    expect(services).toBeUndefined();
    expect(ports.map((p: { guest: number }) => p.guest)).toEqual([3000, 60999]);
    const [web, amikad] = ports as { host: number }[];
    expect(web.host).not.toBe(amikad.host);
    expect(created.services.map((s) => [s.hostPort, s.url])).toEqual([
      [web.host, `http://127.0.0.1:${web.host}`],
      [web.host, `http://127.0.0.1:${web.host}`],
      [amikad.host, `https://127.0.0.1:${amikad.host}`],
    ]);
  });

  it("leaves publishing to amika-hostd when it routes services by name", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(MACHINE));
    const config = { network: true };
    const ops = smolOperations(config, new SmolClient(config, fetcher), {
      serviceRoutes: (services) =>
        services.map((s) => ({ name: s.name, port: s.containerPort })),
    });
    await ops.create({ ...INPUT, services: [service("web", 3000)] });
    const sent = body(fetcher as never, 0);
    expect(sent.ports).toBeUndefined();
    expect(sent.services).toEqual([{ name: "web", port: 3000 }]);
  });

  const PUBLISHED = { ...MACHINE, ports: [{ host: 41001, guest: 3000 }] };

  it("refreshes local URLs from the machine's published ports", async () => {
    const { ops } = harness([json(PUBLISHED)]);
    const { services } = await ops.refreshUrls(INPUT.name, [
      service("web", 3000),
      service("other", 4000),
    ]);
    expect(services[0]).toMatchObject({
      hostPort: 41001,
      url: "http://127.0.0.1:41001",
    });
    expect(services[1]).toEqual(service("other", 4000));
  });

  it("accepts routes on exactly the published ports", async () => {
    const { ops } = harness([json(PUBLISHED), json(PUBLISHED)]);
    await ops.syncRoutes(INPUT.name, [service("site", 3000)]);
    // Revoking one of two services on a port leaves the port routed.
    await ops.syncRoutes(INPUT.name, [
      service("site", 3000),
      service("admin", 3000),
    ]);
  });

  it.each([
    [
      "a port the machine did not publish",
      [service("api", 4000)],
      "does not publish 4000",
    ],
    ["dropping a published port", [], "still publishes 3000"],
  ])("refuses %s", async (_label, desired, message) => {
    const { ops } = harness([json(PUBLISHED)]);
    const failure = await ops
      .syncRoutes(INPUT.name, desired)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SmolPortsError);
    expect((failure as Error).message).toContain(message);
  });

  it("refuses a service switched to UDP without asking smolvm", async () => {
    const { ops, fetcher } = harness([]);
    await expect(
      ops.syncRoutes(INPUT.name, [
        { ...service("dns", 3000), protocol: "udp" },
      ]),
    ).rejects.toBeInstanceOf(SandboxProviderUnsupportedError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

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
          name: "dns",
          url: "",
          hostPort: 0,
          containerPort: 53,
          protocol: "udp" as const,
        },
      ],
    },
    { snapshot: "" },
    { name: "../another-machine" },
    { resources: { vcpus: 0, memoryGib: 1, diskGib: 20 } },
    { resources: { vcpus: 1, memoryGib: 63 / 1024, diskGib: 20 } },
    { resources: { vcpus: 17, memoryGib: 1, diskGib: 20 } },
  ])(
    "rejects unsupported or invalid create input before allocating: %j",
    async (input) => {
      const { ops, fetcher } = harness([]);
      await expect(ops.create({ ...INPUT, ...input })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("accepts smolvm's minimum memory", async () => {
    const { ops, fetcher } = harness([
      json(MACHINE),
      json({ ...MACHINE, state: "running" }),
    ]);
    await ops.create({
      ...INPUT,
      resources: { vcpus: 1, memoryGib: 64 / 1024, diskGib: 20 },
    });
    expect(body(fetcher, 0)).toMatchObject({ memoryMb: 64 });
  });

  it("reads stopped state without starting a machine", async () => {
    const { ops, fetcher } = harness([json(MACHINE)]);
    expect(await ops.getState(INPUT.name)).toBe("stopped");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(mapSmolState("stopped")).toBe("stopped");
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
