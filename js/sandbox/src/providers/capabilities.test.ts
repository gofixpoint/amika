import { describe, expect, it } from "vitest";
import { getSandboxProviderLabel } from "./capabilities";

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
