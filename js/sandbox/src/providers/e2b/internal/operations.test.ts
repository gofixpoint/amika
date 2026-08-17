import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  pause: vi.fn(),
  kill: vi.fn(),
  getInfo: vi.fn(),
  getMetrics: vi.fn(),
  list: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: sdk,
  CommandExitError: class CommandExitError extends Error {},
  FileNotFoundError: class FileNotFoundError extends Error {},
}));

import {
  createE2bSandbox,
  deleteE2bSandbox,
  listE2bSandboxes,
  refreshE2bUrls,
  startE2bSandbox,
  stopE2bSandbox,
} from "./operations";

const CONFIG = { apiKey: "e2b_test" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E2B lifecycle operations", () => {
  it("creates from the prepared template with pause-on-timeout lifecycle", async () => {
    sdk.create.mockResolvedValue({ sandboxId: "sbx_1" });

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
      lifecycle: { onTimeout: "pause", autoResume: false },
      network: { allowPublicTraffic: true },
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

  it("resumes, pauses with memory, and kills the same sandbox id", async () => {
    sdk.connect.mockResolvedValue({});
    await startE2bSandbox(CONFIG, "sbx_1", 10);
    await stopE2bSandbox(CONFIG, "sbx_1");
    await deleteE2bSandbox(CONFIG, "sbx_1");

    expect(sdk.connect).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
      timeoutMs: 10 * 60_000,
    });
    expect(sdk.pause).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
      keepMemory: true,
    });
    expect(sdk.kill).toHaveBeenCalledWith("sbx_1", {
      apiKey: "e2b_test",
    });
  });
});

describe("E2B services and listing", () => {
  it("refreshes every service to its stable HTTPS host", async () => {
    sdk.connect.mockResolvedValue({
      getHost: (port: number) => `${port}-sbx_1.e2b.app`,
    });

    const result = await refreshE2bUrls(CONFIG, "sbx_1", [
      { name: "Coding Agent", containerPort: 3000, url: null },
      { name: "Preview", containerPort: 5173, url: null },
    ] as never);

    expect(result.providerUrl).toBe("https://3000-sbx_1.e2b.app");
    expect(result.services.map((service) => service.url)).toEqual([
      "https://3000-sbx_1.e2b.app",
      "https://5173-sbx_1.e2b.app",
    ]);
  });

  it("paginates listings and omits sandboxes without usable disk metrics", async () => {
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

    await expect(listE2bSandboxes(CONFIG)).resolves.toEqual([
      {
        providerSandboxId: "sbx_1",
        orgId: "org_1",
        state: "running",
        sizing: { vcpus: 2, memoryGib: 8, diskGib: 10 },
      },
    ]);
  });
});
