import { describe, expect, it } from "vitest";
import type { VercelConfig } from "./config";
import { createSandboxProvider, type SandboxProviderDeps } from "../registry";

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
    e2b: null,
    freestyle: null,
    vercel,
    smol: null,
    amikaHostd: null,
    simulate: null,
    resolveSnapshotId: async () => null,
  };
}

describe("vercel snapshots", () => {
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
