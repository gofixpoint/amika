import { describe, expect, it } from "vitest";
import {
  E2B_DEFAULT_TIMEOUT_MS,
  E2B_MAX_TIMEOUT_MS,
  e2bTimeoutMs,
  mapE2bSandboxState,
} from "./internal/operations";

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
    expect(mapE2bSandboxState("paused")).toBe("stopped");
    expect(mapE2bSandboxState("destroyed")).toBe("unknown");
  });
});
