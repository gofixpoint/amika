// Read-only org-scoped endpoints plus the SSH public key round trip. Nothing
// here provisions a sandbox, so this suite is cheap enough to run on its own.

import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";
import { canonicalEd25519PublicKey } from "@/ssh-session";

import {
  describeFunctional,
  makeClient,
  uniqueSuffix,
} from "@test/functional/helpers";

// Public key material only — the matching private key was discarded.
const TEST_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4ilkUClOhQyh1hQBSn7N/cMSpX0oqg4P87b21Qqdvt";

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

  describe("ssh public keys", () => {
    it("create + list + delete round-trips", async () => {
      const name = `ts-sdk-fn-${uniqueSuffix()}`;
      const publicKey = canonicalEd25519PublicKey(TEST_PUBLIC_KEY);
      expect(publicKey).not.toBe("");

      const created = await client.createSSHPublicKey({ name, publicKey });
      expect(created.name).toBe(name);
      expect(created.id).not.toBe("");

      try {
        const keys = await client.listSSHPublicKeys();
        const found = keys.find((k) => k.id === created.id);
        expect(found).toBeDefined();
        // The server canonicalizes the same way the SDK does.
        expect(found?.publicKey).toBe(publicKey);
      } finally {
        await client.deleteSSHPublicKey(created.id);
      }

      const after = await client.listSSHPublicKeys();
      expect(after.some((k) => k.id === created.id)).toBe(false);
    });
  });
});
