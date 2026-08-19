import { describe, expect, it } from "vitest";
import {
  buildFreestyleVmName,
  freestyleVmBelongsToOrg,
  freestyleVmNameOrgId,
} from "./naming";

describe("buildFreestyleVmName", () => {
  it("prefixes the org id onto the sandbox name", () => {
    expect(buildFreestyleVmName("org_abc123", "my-sandbox")).toBe(
      "org_abc123/my-sandbox",
    );
  });

  it("round-trips through freestyleVmNameOrgId", () => {
    const name = buildFreestyleVmName("org_abc123", "my-sandbox");
    expect(freestyleVmNameOrgId(name)).toBe("org_abc123");
  });
});

describe("freestyleVmNameOrgId", () => {
  it("recovers the org id from a scoped name", () => {
    expect(freestyleVmNameOrgId("org_abc123/my-sandbox")).toBe("org_abc123");
  });

  it("splits on the first separator so the name may contain slashes", () => {
    expect(freestyleVmNameOrgId("org_abc123/team/my-sandbox")).toBe(
      "org_abc123",
    );
  });

  it("returns null for an unscoped name", () => {
    expect(freestyleVmNameOrgId("legacy-sandbox")).toBeNull();
  });

  it("returns null for a null or empty name", () => {
    expect(freestyleVmNameOrgId(null)).toBeNull();
    expect(freestyleVmNameOrgId("")).toBeNull();
  });

  it("returns null when the name starts with the separator (no org)", () => {
    expect(freestyleVmNameOrgId("/my-sandbox")).toBeNull();
  });
});

describe("freestyleVmBelongsToOrg", () => {
  it("is true when the org prefix matches", () => {
    expect(freestyleVmBelongsToOrg("org_abc123/my-sandbox", "org_abc123")).toBe(
      true,
    );
  });

  it("is false for a different org", () => {
    expect(freestyleVmBelongsToOrg("org_abc123/my-sandbox", "org_other")).toBe(
      false,
    );
  });

  it("fails closed for an unscoped name", () => {
    expect(freestyleVmBelongsToOrg("legacy-sandbox", "org_abc123")).toBe(false);
  });
});
