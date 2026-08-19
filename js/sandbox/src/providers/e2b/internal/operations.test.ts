import { beforeEach, describe, expect, it, vi } from "vitest";

const { sdk, FakeSandboxNotFoundError } = vi.hoisted(() => ({
  sdk: {
    create: vi.fn(),
    connect: vi.fn(),
    pause: vi.fn(),
    kill: vi.fn(),
    getInfo: vi.fn(),
    getMetrics: vi.fn(),
    getSandboxDetail: vi.fn(),
    list: vi.fn(),
  },
  FakeSandboxNotFoundError: class SandboxNotFoundError extends Error {},
}));

vi.mock("e2b", () => ({
  ApiClient: class ApiClient {
    api = { GET: sdk.getSandboxDetail };
  },
  Sandbox: sdk,
  ConnectionConfig: class ConnectionConfig {},
  CommandExitError: class CommandExitError extends Error {},
  FileNotFoundError: class FileNotFoundError extends Error {},
  SandboxNotFoundError: FakeSandboxNotFoundError,
}));

import {
  createE2bSandbox,
  deleteE2bSandbox,
  e2bImagePermissionRestoreCommand,
  e2bRouteRestoreCommand,
  e2bRouteSyncCommand,
  getE2bSandboxState,
  listE2bSandboxes,
  refreshE2bUrls,
  startE2bSandbox,
  stopE2bSandbox,
  syncE2bRoutes,
} from "./operations";

const CONFIG = { apiKey: "e2b_test" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E2B lifecycle operations", () => {
  it("creates from the prepared template with pause-on-timeout lifecycle", async () => {
    const run = vi.fn().mockResolvedValue({});
    sdk.create.mockResolvedValue({ sandboxId: "sbx_1", commands: { run } });

    const result = await createE2bSandbox(
      { logger: { info: vi.fn() } } as never,
      CONFIG,
      {
        name: "demo",
        snapshot: "tpl_coder_xs",
        labels: { "amika-org-id": "org_1" },
        autoStopInterval: 15,
        services: [],
      } as never,
    );

    expect(sdk.create).toHaveBeenCalledWith("tpl_coder_xs", {
      apiKey: "e2b_test",
      metadata: {
        "amika-org-id": "org_1",
        "amika-sandbox-name": "demo",
      },
      timeoutMs: 15 * 60_000,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: false },
        autoResume: false,
      },
      network: { allowPublicTraffic: true },
    });
    expect(run).toHaveBeenCalledWith(e2bImagePermissionRestoreCommand(), {
      user: "root",
    });
    expect(result).toMatchObject({
      provider: "e2b",
      providerSandboxId: "sbx_1",
    });
  });

  it("rejects creation without a prepared template", async () => {
    await expect(
      createE2bSandbox({ logger: { info: vi.fn() } } as never, CONFIG, {
        name: "demo",
        snapshot: "",
      } as never),
    ).rejects.toThrow(/E2B_TEMPLATE/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("kills a new sandbox when restoring image permissions fails", async () => {
    const restoreError = new Error("chmod failed");
    const run = vi.fn().mockRejectedValue(restoreError);
    sdk.create.mockResolvedValue({ sandboxId: "sbx_1", commands: { run } });
    sdk.kill.mockResolvedValue(undefined);

    await expect(
      createE2bSandbox(
        { logger: { info: vi.fn(), error: vi.fn() } } as never,
        CONFIG,
        {
          name: "demo",
          snapshot: "tpl_coder_xs",
          labels: {},
          services: [],
        } as never,
      ),
    ).rejects.toBe(restoreError);

    expect(sdk.kill).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
    });
  });

  it("resumes, pauses with only filesystem state, and kills the sandbox", async () => {
    const run = vi.fn().mockResolvedValue({});
    sdk.connect.mockResolvedValue({ commands: { run } });
    await startE2bSandbox(CONFIG, "sbx_1", 10);
    await stopE2bSandbox(CONFIG, "sbx_1");
    await deleteE2bSandbox(CONFIG, "sbx_1");

    expect(sdk.connect).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
      timeoutMs: 10 * 60_000,
    });
    expect(run).toHaveBeenCalledWith(e2bRouteRestoreCommand(), {
      user: "root",
    });
    expect(sdk.pause).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
      keepMemory: false,
    });
    expect(sdk.kill).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
    });
  });

  it("returns unknown only when E2B reports a missing sandbox", async () => {
    sdk.getInfo.mockRejectedValueOnce(new FakeSandboxNotFoundError("missing"));
    await expect(getE2bSandboxState(CONFIG, "sbx_gone")).resolves.toBe(
      "unknown",
    );

    sdk.getInfo.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(getE2bSandboxState(CONFIG, "sbx_1")).rejects.toThrow(
      "network unavailable",
    );
  });
});

describe("E2B services and listing", () => {
  it("refreshes every service to its stable HTTPS host", async () => {
    const run = vi.fn().mockResolvedValue({});
    sdk.connect.mockResolvedValue({
      commands: { run },
      getHost: (port: number) => `${port}-sbx_1.e2b.app`,
    });

    const services = [
      { name: "Coding Agent", containerPort: 3000, url: null },
      { name: "Preview", containerPort: 5173, url: null },
    ] as never;
    const result = await refreshE2bUrls(CONFIG, "sbx_1", services);

    expect(run).toHaveBeenCalledWith(e2bRouteSyncCommand(services), {
      user: "root",
    });
    expect(result.providerUrl).toBe("https://3000-sbx_1.e2b.app");
    expect(result.services.map((service) => service.url)).toEqual([
      "https://3000-sbx_1.e2b.app",
      "https://5173-sbx_1.e2b.app",
    ]);
  });

  it("reconciles removed service ports through a persistent firewall chain", async () => {
    const run = vi.fn().mockResolvedValue({});
    sdk.connect.mockResolvedValue({ commands: { run } });
    const services = [
      { name: "Preview", containerPort: 5173, url: null },
      { name: "Agent", containerPort: 3000, url: null },
      { name: "Preview duplicate", containerPort: 5173, url: null },
    ] as never;

    await syncE2bRoutes(CONFIG, "sbx_1", services);

    expect(sdk.connect).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
    });
    expect(run).toHaveBeenCalledWith(e2bRouteSyncCommand(services), {
      user: "root",
    });
    const command = run.mock.calls[0]![0] as string;
    expect(command).toContain("chain=AMIKA_E2B_ROUTES");
    expect(command).toContain("desired_ports='3000 5173'");
    expect(command).toContain("e2b-route-ports");
    expect(command).toContain("e2b-route-desired-ports");
    expect(command).toContain("firewall_count");
    expect(command).toContain("-j REJECT --reject-with tcp-reset");
  });

  it("restores the persisted desired routes after a cold resume", () => {
    const command = e2bRouteRestoreCommand();

    expect(command).toContain('if [ ! -f "$desired_state_file" ]');
    expect(command).toContain('desired_ports="$(cat "$desired_state_file")"');
    expect(command).not.toContain('> "$desired_state_file.tmp"');
  });

  it("rejects an invalid desired service port before connecting", async () => {
    await expect(
      syncE2bRoutes(CONFIG, "sbx_1", [
        { name: "bad", containerPort: 70_000, url: null },
      ] as never),
    ).rejects.toThrow("Invalid E2B service port");
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("paginates listings without dropping sandboxes missing disk metrics", async () => {
    const pages = [
      [
        {
          sandboxId: "sbx_1",
          metadata: { "amika-org-id": "org_1" },
          state: "running",
          cpuCount: 2,
          memoryMB: 8192,
        },
        {
          sandboxId: "sbx_new",
          metadata: {},
          state: "paused",
          cpuCount: 1,
          memoryMB: 1024,
        },
      ],
    ];
    sdk.list.mockReturnValue({
      get hasNext() {
        return pages.length > 0;
      },
      nextItems: async () => pages.shift(),
    });
    sdk.getMetrics.mockImplementation(async (id: string) =>
      id === "sbx_1" ? [{ diskTotal: 10 * 1024 ** 3 }] : [],
    );
    sdk.getSandboxDetail.mockResolvedValue({
      data: { diskSizeMB: 20 * 1024 },
    });

    await expect(listE2bSandboxes(CONFIG)).resolves.toEqual([
      {
        providerSandboxId: "sbx_1",
        orgId: "org_1",
        state: "running",
        sizing: { vcpus: 2, memoryGib: 8, diskGib: 10 },
      },
      {
        providerSandboxId: "sbx_new",
        orgId: null,
        state: "paused",
        sizing: { vcpus: 1, memoryGib: 1, diskGib: 20 },
      },
    ]);
    expect(sdk.getSandboxDetail).toHaveBeenCalledWith(
      "/sandboxes/{sandboxID}",
      { params: { path: { sandboxID: "sbx_new" } } },
    );
  });
});
