// Read-only org-scoped endpoints. Nothing here provisions a sandbox, so this
// suite is cheap enough to run on its own.

import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";

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
  });

  describe("ssh public keys", () => {
    it("create + list + delete round-trips", async () => {
      const name = `ts-sdk-fn-${uniqueSuffix()}`;

      const created = await client.createSSHPublicKey({
        name,
        publicKey: TEST_PUBLIC_KEY,
      });
      expect(created.name).toBe(name);
      expect(created.id).not.toBe("");

      try {
        const keys = await client.listSSHPublicKeys();
        expect(keys.some((k) => k.id === created.id)).toBe(true);
      } finally {
        await client.deleteSSHPublicKey(created.id);
      }

      const after = await client.listSSHPublicKeys();
      expect(after.some((k) => k.id === created.id)).toBe(false);
    });
  });
});
