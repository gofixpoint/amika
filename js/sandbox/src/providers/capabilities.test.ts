import { describe, expect, it } from "vitest";
import {
  getSandboxProviderLabel,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "./capabilities";

describe("getSandboxProviderLabel", () => {
  it("labels a Daytona VM", () => {
    expect(getSandboxProviderLabel("daytona", true)).toBe("Daytona VM");
  });

  it("labels a Daytona container when isVm is false", () => {
    expect(getSandboxProviderLabel("daytona", false)).toBe("Daytona Container");
  });

  it("treats an unknown Daytona isVm (null/undefined) as a container", () => {
    // Sandboxes created before VM tracking have a null `isVm`; they are
    // containers, so they must not read as "VM".
    expect(getSandboxProviderLabel("daytona", null)).toBe("Daytona Container");
    expect(getSandboxProviderLabel("daytona", undefined)).toBe(
      "Daytona Container",
    );
  });

  it("leaves non-Daytona providers unqualified", () => {
    expect(getSandboxProviderLabel("freestyle", true)).toBe("Freestyle");
    expect(getSandboxProviderLabel("vercel", false)).toBe("Vercel");
  });

  it("falls back to the raw name for unknown providers", () => {
    expect(getSandboxProviderLabel("mystery", null)).toBe("mystery");
  });
});

describe("skipStartScript capability", () => {
  // This flag is the UI gate for the Start button's "start without running
  // start script" dropdown. It must be true only for providers whose
  // `rerunLifecycle` actually forwards `skipStartScript` to the shared
  // lifecycle runner, otherwise the dropdown would render a silent no-op.
  it("is advertised by the providers that wire it through (Daytona, Vercel)", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.daytona.skipStartScript).toBe(true);
    expect(SANDBOX_PROVIDER_CAPABILITIES.vercel.skipStartScript).toBe(true);
  });

  it("stays off for providers that always run the start script", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.freestyle.skipStartScript).toBe(false);
  });
});
