import { describe, expect, it } from "vitest";
import { providerDepsFromEnv, targetIdentity } from "./env-target";

describe("targetIdentity", () => {
  it("records where resources live and only a hash of the credential", () => {
    const deps = providerDepsFromEnv("daytona", {
      DAYTONA_API_KEY: "dtn_secret_value",
      DAYTONA_API_URL: "https://daytona.example/api",
      DAYTONA_ORGANIZATION_ID: "org-a",
      ENABLE_DAYTONA_VM: "true",
    });
    const identity = targetIdentity("daytona", deps);
    expect(identity).toEqual({
      provider: "daytona",
      apiUrl: "https://daytona.example/api",
      target: "",
      organizationId: "org-a",
      apiKeySha256: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(JSON.stringify(identity)).not.toContain("dtn_secret_value");
  });
});
