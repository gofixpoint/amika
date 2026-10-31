import { describe, expect, it } from "vitest";
import { moduleLogger, type SandboxCtx } from "../../logger";
import { getProviderCapabilities, getProviderLabel } from "../capabilities";
import { amikaHostdBareMetalProvider } from "./provider";

const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };
const CONFIG = { apiUrl: "http://127.0.0.1:3020", secretKey: "k".repeat(64) };

describe("amika-hostd bare-metal provider", () => {
  it("keeps the SSH bridge's exec and services but provisions nothing", () => {
    const provider = amikaHostdBareMetalProvider({ config: CONFIG });
    expect(provider.name).toBe("amika-hostd-bare-metal");
    expect(provider.capabilities).toMatchObject({
      lifecycle: true,
      exec: true,
      services: true,
      snapshots: false,
      scrubCapture: false,
      guestProvisioning: false,
    });
    expect(provider.snapshots).toBeNull();
  });

  it("sends no resources, so a large host's detected ones never fail create", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/rigs")) {
        bodies.push(JSON.parse(String(init.body)));
      }
      return Response.json({
        name: "rig",
        state: "running",
        cpus: 1,
        memoryMb: 1024,
        storageGb: 1,
      });
    };
    const provider = amikaHostdBareMetalProvider({ config: CONFIG, fetcher });
    await provider.sandboxes.create(ctx, {
      name: "rig",
      snapshot: "bare-metal",
      services: [],
      resources: { vcpus: 32, memoryGib: 62.6, diskGib: 931.5 },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("cpus");
    expect(bodies[0]).not.toHaveProperty("memoryMb");
    expect(bodies[0]).not.toHaveProperty("storageGb");
  });

  it("refuses file writes, which a bare-metal host does not serve", async () => {
    const sandbox = amikaHostdBareMetalProvider({
      config: CONFIG,
    }).sandboxes.get("rig");
    await expect(sandbox.writeFile("/tmp/x", "y")).rejects.toThrow();
  });

  it("is registered with client-safe capabilities and a label", () => {
    expect(getProviderCapabilities("amika-hostd-bare-metal")).toMatchObject({
      guestProvisioning: false,
    });
    expect(getProviderCapabilities("amika-hostd")).toMatchObject({
      guestProvisioning: true,
    });
    expect(getProviderLabel("amika-hostd-bare-metal")).toMatch(/bare metal/u);
  });
});
