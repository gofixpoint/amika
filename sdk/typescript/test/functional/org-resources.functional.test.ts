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

    it("listAgentSessions returns a page and its total", async () => {
      const page = await client.listAgentSessions(5);
      expect(Array.isArray(page.sessions)).toBe(true);
      expect(page.sessions.length).toBeLessThanOrEqual(5);
      expect(typeof page.total).toBe("number");
    });

    it("getAgentSession returns the transcript for a listed chat", async () => {
      const page = await client.listAgentSessions(1);
      const summary = page.sessions[0];
      if (!summary) return; // Fresh org with no chats yet.

      const detail = await client.getAgentSession(summary.sessionId);
      expect(detail.sessionId).toBe(summary.sessionId);
      expect(Array.isArray(detail.messages)).toBe(true);
    });
  });
});
