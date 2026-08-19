import { describe, expect, it } from "vitest";
import {
  getProviderLabel,
  isSandboxProviderName,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "../capabilities";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";
import {
  E2B_DEFAULT_TIMEOUT_MS,
  E2B_MAX_TIMEOUT_MS,
  E2B_URL_TTL_S,
  e2bTimeoutMs,
  mapE2bSandboxState,
} from "./internal/operations";

function deps(apiKey: string | null): SandboxProviderDeps {
  return {
    daytona: {
      apiKey: "",
      apiUrl: "",
      target: undefined,
      organizationId: undefined,
      useVm: false,
    },
    e2b: apiKey ? { apiKey } : null,
    freestyle: null,
    vercel: null,
    resolveSnapshotId: async () => null,
  };
}

describe("e2b provider wiring", () => {
  it("is recognized and has client-safe display data", () => {
    expect(isSandboxProviderName("e2b")).toBe(true);
    expect(getProviderLabel("e2b")).toBe("E2B");
  });

  it("advertises the supported E2B operations", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.e2b).toEqual({
      lifecycle: true,
      ssh: false,
      services: true,
      exec: true,
      listSandboxes: true,
      streaming: true,
      snapshots: true,
      scrubCapture: true,
      fullSnapshotCapture: true,
      dockerRegistries: false,
      skipStartScript: true,
      snapshotIdsAreOpaque: true,
      supportsAutoDelete: false,
    });
  });

  it("constructs when configured and rejects missing credentials", () => {
    const provider = createSandboxProvider("e2b", deps("e2b_test"));
    expect(provider.name).toBe("e2b");
    expect(provider.signedUrlTtlSeconds).toBe(E2B_URL_TTL_S);
    expect(provider.sandboxes.get("sbx").ssh).toBeNull();
    expect(provider.sandboxes.get("sbx").services).not.toBeNull();
    expect(() => createSandboxProvider("e2b", deps(null))).toThrow(
      /not configured/,
    );
  });
});

describe("E2B lifecycle mapping", () => {
  it("uses a 30 minute default and caps timeouts at 24 hours", () => {
    expect(e2bTimeoutMs()).toBe(E2B_DEFAULT_TIMEOUT_MS);
    expect(e2bTimeoutMs(null)).toBe(E2B_DEFAULT_TIMEOUT_MS);
    expect(e2bTimeoutMs(15)).toBe(15 * 60_000);
    expect(e2bTimeoutMs(0)).toBe(E2B_MAX_TIMEOUT_MS);
    expect(e2bTimeoutMs(-1)).toBe(E2B_MAX_TIMEOUT_MS);
    expect(e2bTimeoutMs(48 * 60)).toBe(E2B_MAX_TIMEOUT_MS);
  });

  it("maps E2B states to Amika states", () => {
    expect(mapE2bSandboxState("running")).toBe("running");
    expect(mapE2bSandboxState("paused")).toBe("suspended");
    expect(mapE2bSandboxState("destroyed")).toBe("unknown");
  });
});
