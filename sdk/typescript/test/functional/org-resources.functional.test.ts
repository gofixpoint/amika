// Read-only org-scoped endpoints. Nothing here provisions a sandbox, so this
// suite is cheap enough to run on its own.

import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";

import { describeFunctional, makeClient } from "@test/functional/helpers";

describeFunctional("org resources functional tests", () => {
  let client: AmikaClient;

  beforeAll(() => {
    client = makeClient();
  });

  describe("read-only listings", () => {
    it("listRepositories returns the org's repositories", async () => {
      const repos = await client.listRepositories();
      expect(Array.isArray(repos)).toBe(true);
      for (const repo of repos) {
        expect(typeof repo.id).toBe("string");
        expect(typeof repo.repoUrl).toBe("string");
      }
    });

    it("listSandboxServices returns every service in the org", async () => {
      const services = await client.listSandboxServices();
      expect(Array.isArray(services)).toBe(true);
      for (const service of services) {
        expect(typeof service.name).toBe("string");
        expect(typeof service.port).toBe("number");
        expect(["table", "legacy"]).toContain(service.source);
      }
    });
  });
});
