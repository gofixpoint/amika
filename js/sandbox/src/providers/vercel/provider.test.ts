import { describe, expect, it } from "vitest";
import type { VercelConfig } from "./config";
import {
  getProviderLabel,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "../capabilities";
import {
  createSandboxProvider,
  isSandboxProviderName,
  type SandboxProviderDeps,
} from "../registry";

const VERCEL_CONFIG: VercelConfig = {
  apiKey: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
};

function vercelDeps(vercel: VercelConfig | null): SandboxProviderDeps {
  return {
    daytona: {
      apiKey: "",
      apiUrl: "",
      target: undefined,
      organizationId: undefined,
      useVm: false,
    },
    freestyle: null,
    sailbox: null,
    vercel,
    resolveSnapshotId: async () => null,
  };
}

describe("vercel provider wiring", () => {
  it("is a recognized provider name", () => {
    expect(isSandboxProviderName("vercel")).toBe(true);
    expect(isSandboxProviderName("nope")).toBe(false);
  });

  it("advertises generic no-relay prerequisites without legacy SSH", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.vercel).toEqual({
      lifecycle: true,
      ssh: false,
      services: true,
      exec: true,
      listSandboxes: true,
      streaming: true,
      snapshots: true,
      scrubCapture: true,
      // Only scrub-and-delete capture is supported; full mode is rejected.
      fullSnapshotCapture: false,
      dockerRegistries: false,
      // Vercel honors skipStartScript on start.
      skipStartScript: true,
      // Snapshots are id-only; persistent microVMs aren't auto-deleted.
      snapshotIdsAreOpaque: true,
      supportsAutoDelete: false,
    });
  });

  it("has a display label", () => {
    expect(getProviderLabel("vercel")).toBe("Vercel");
  });

  it("resolves to a Vercel provider when configured", () => {
    const provider = createSandboxProvider("vercel", vercelDeps(VERCEL_CONFIG));
    expect(provider.name).toBe("vercel");
    // Snapshots (per-sandbox capture) are supported; docker registries and
    // image-derived snapshots (control-plane) are intentionally absent.
    expect(provider.snapshots).not.toBeNull();
    expect(provider.docker).toBeNull();
  });

  it("throws a clear error when Vercel is not configured", () => {
    expect(() => createSandboxProvider("vercel", vercelDeps(null))).toThrow(
      /not configured/,
    );
  });

  it("uses generic no-relay SSH instead of the legacy private-key bridge", () => {
    const provider = createSandboxProvider("vercel", vercelDeps(VERCEL_CONFIG));
    // No-relay SSH replaces the legacy private-key bridge: the provider no
    // longer exposes an `ssh` capability. Instead it advertises `services` (so
    // amikad's port can be published on demand) plus stdin-capable exec.
    const sbox = provider.sandboxes.get("sbx");
    expect(sbox.ssh).toBeNull();
    expect(sbox.services).not.toBeNull();
    expect(provider.capabilities.ssh).toBe(false);
    expect(provider.capabilities.services).toBe(true);
  });

  it("throws on non-destructive full capture — only scrub-and-delete is supported", async () => {
    const provider = createSandboxProvider("vercel", vercelDeps(VERCEL_CONFIG));
    const sandboxSnapshots = provider.sandboxes.get("sbx").snapshots;
    expect(sandboxSnapshots).not.toBeNull();
    // A Vercel sandbox is created with `keepLastSnapshots: { count: 1 }`, so a
    // full capture that keeps the source alive would be evicted by its next
    // auto-snapshot; the provider offers only scrub-and-delete and throws here.
    await expect(
      sandboxSnapshots?.create("org_x/sandbox/snap"),
    ).rejects.toThrow(/does not support operation "capture"/);
  });
});
