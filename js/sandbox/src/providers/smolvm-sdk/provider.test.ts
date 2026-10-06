import { describe, expect, it, vi } from "vitest";
import type { MachineSummary } from "smolmachines";
import {
  getProviderLabel,
  isSandboxProviderName,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "../capabilities";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import { moduleLogger, type SandboxCtx } from "../../logger";
import smolvmSdkProvider, { type SmolMachines } from "./provider";

function deps(enabled: boolean): SandboxProviderDeps {
  return {
    daytona: {
      apiKey: "",
      apiUrl: "",
      target: undefined,
      organizationId: undefined,
      useVm: false,
    },
    e2b: null,
    freestyle: null,
    vercel: null,
    smol: null,
    smolvmSdk: enabled ? {} : null,
    amikaHostd: null,
    resolveSnapshotId: async () => null,
  };
}

const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

describe("smolvm-sdk provider wiring", () => {
  it("is recognized and has client-safe display data", () => {
    expect(isSandboxProviderName("smolvm-sdk")).toBe(true);
    expect(getProviderLabel("smolvm-sdk")).toBe("Smol (embedded)");
    expect(SANDBOX_PROVIDER_CAPABILITIES["smolvm-sdk"]).toMatchObject({
      lifecycle: true,
      services: true,
      exec: true,
      listSandboxes: true,
      snapshots: false,
      ssh: false,
    });
  });

  it("needs its config slice", () => {
    expect(() => createSandboxProvider("smolvm-sdk", deps(false))).toThrow(
      /SMOLVM_SDK_ENABLED/,
    );
    expect(createSandboxProvider("smolvm-sdk", deps(true)).name).toBe(
      "smolvm-sdk",
    );
  });

  it("serves the resource surface over the SDK", async () => {
    const machine = {
      start: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "hi\n", stderr: "" })),
      readFile: vi.fn(async () => Buffer.from("")),
      writeFile: vi.fn(async () => {}),
    };
    let summary: MachineSummary | undefined;
    const machines: SmolMachines = {
      create: vi.fn(async (config) => {
        summary = {
          name: config.name ?? "",
          id: config.name ?? "",
          state: "running",
          labels: config.labels ?? {},
          persistent: true,
          detached: false,
          branchable: false,
          createdAt: "2026-10-06T00:00:00Z",
        };
        return machine;
      }),
      connect: vi.fn(async () => machine),
      list: vi.fn(async () => (summary ? [summary] : [])),
      localAvailability: () => ({ available: true }),
    };
    const provider = smolvmSdkProvider({}, machines);
    const sandbox = await provider.sandboxes.create(ctx, {
      name: "demo",
      snapshot: "ubuntu:24.04",
      services: [],
    });
    expect(sandbox.id).toBe("demo");
    expect(await sandbox.getRuntimeState()).toBe("running");
    expect(await sandbox.exec("echo hi")).toEqual({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
    });
    expect(provider.userHomeDir).toBe("/root");
  });
});
