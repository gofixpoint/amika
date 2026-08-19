import { describe, expect, it } from "vitest";
import {
  getProviderLabel,
  isSandboxProviderName,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "../capabilities";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";

function deps(overrides: Partial<SandboxProviderDeps>): SandboxProviderDeps {
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
    resolveSnapshotId: async () => null,
    ...overrides,
  };
}

describe("freestyle provider wiring", () => {
  it("is a recognized provider name", () => {
    expect(isSandboxProviderName("freestyle")).toBe(true);
    expect(isSandboxProviderName("nope")).toBe(false);
  });

  it("advertises lifecycle + exec + ssh + snapshots, with streaming and docker registries off", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.freestyle).toEqual({
      lifecycle: true,
      ssh: true,
      services: true,
      exec: true,
      listSandboxes: true,
      streaming: false,
      snapshots: true,
      scrubCapture: true,
      fullSnapshotCapture: true,
      dockerRegistries: false,
      skipStartScript: false,
      snapshotIdsAreOpaque: true,
      supportsAutoDelete: false,
    });
  });

  it("has a display label", () => {
    expect(getProviderLabel("freestyle")).toBe("Freestyle");
  });

  it("resolves to the freestyle provider when configured", () => {
    const provider = createSandboxProvider(
      "freestyle",
      deps({ freestyle: { apiKey: "test-key" } }),
    );
    expect(provider.name).toBe("freestyle");
    // Sandbox-capture snapshots are supported; docker registries (control-plane)
    // are intentionally absent.
    expect(provider.snapshots).not.toBeNull();
    expect(provider.docker).toBeNull();
  });

  it("throws a clear error when Freestyle is not configured", () => {
    expect(() =>
      createSandboxProvider("freestyle", deps({ freestyle: null })),
    ).toThrow(/not configured/);
  });
});
