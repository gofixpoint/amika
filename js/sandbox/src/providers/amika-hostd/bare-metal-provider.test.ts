import { describe, expect, it } from "vitest";
import { getProviderCapabilities, getProviderLabel } from "../capabilities";
import { amikaHostdBareMetalProvider } from "./provider";

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
