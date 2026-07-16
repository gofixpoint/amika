import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";
import { AmikaHTTPError } from "@/errors";
import type { AgentCredentialRef, RemoteSandbox } from "@/types";

import {
  describeFunctional,
  ensureGitHubToken,
  LONG_TIMEOUT_MS,
  makeClient,
  provisionSandbox,
  TEST_AGENT_NAME,
} from "@test/functional/helpers";

describeFunctional("sandbox functional tests", () => {
  let client: AmikaClient;
  let sandbox: RemoteSandbox;

  beforeAll(async () => {
    client = makeClient();
    await ensureGitHubToken(client);

    const secrets = await client.listProviderSecrets(TEST_AGENT_NAME);
    const apiKeySecret = secrets.find((s) => s.type === "api_key");
    if (!apiKeySecret) {
      throw new Error(
        `No api_key credential found for provider "${TEST_AGENT_NAME}". ` +
          "Add one before running the functional suite.",
      );
    }
    const credential: AgentCredentialRef = {
      kind: TEST_AGENT_NAME,
      type: "api_key",
      ...(apiKeySecret.name ? { name: apiKeySecret.name } : {}),
    };

    sandbox = await provisionSandbox(client, {
      agentCredentials: [credential],
    });
  }, LONG_TIMEOUT_MS);

  describe("provisioning", () => {
    it("createSandbox + waitForSandbox returned a ready sandbox", () => {
      // The actual API calls happened in beforeAll via provisionSandbox; this
      // test makes the assertion explicit so a failure points at the right
      // method instead of cascading into every other test.
      expect(sandbox.id).not.toBe("");
      expect(sandbox.name).not.toBe("");
      expect(["active", "running", "started"]).toContain(sandbox.state);
      expect(sandbox.createdAt).not.toBe("");
    });
  });

  describe("read operations", () => {
    it("getSandbox returns the provisioned sandbox in a ready state", async () => {
      const sb = await client.getSandbox(sandbox.name);
      expect(sb.name).toBe(sandbox.name);
      expect(sb.id).toBe(sandbox.id);
      expect(["active", "running", "started"]).toContain(sb.state);
      // String fields are always present, even if empty.
      expect(typeof sb.repoUrl).toBe("string");
      expect(typeof sb.createdAt).toBe("string");
    });

    it("listSandboxes includes the provisioned sandbox", async () => {
      const all = await client.listSandboxes();
      const match = all.find((s) => s.name === sandbox.name);
      expect(match).toBeDefined();
      expect(match?.id).toBe(sandbox.id);
    });
  });

  describe("SSH", () => {
    it("getSSH returns credentials and revokeSSH revokes them", async () => {
      const info = await client.getSSH(sandbox.name);
      expect(info.sshDestination).not.toBe("");
      expect(info.token).not.toBe("");
      expect(info.expiresAt).not.toBe("");

      // Should accept the token we just minted.
      await client.revokeSSH(sandbox.name, info.token);
    });
  });

  describe("sessions", () => {
    let sessionId: string;

    it("createSession returns a session for the configured agent", async () => {
      const session = await client.createSession(sandbox.name, {
        agentName: TEST_AGENT_NAME,
        metadata: { source: "ts-sdk-functional" },
      });
      expect(session.id).not.toBe("");
      expect(session.agentName).toBe(TEST_AGENT_NAME);
      expect(session.sandboxId).toBe(sandbox.id);
      sessionId = session.id;
    });

    it("listSessions returns the created session in the envelope", async () => {
      const sessions = await client.listSessions(sandbox.name);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
    });

    it("getSession returns the session by id", async () => {
      const session = await client.getSession(sandbox.name, sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.sandboxId).toBe(sandbox.id);
    });

    it("getLatestSession returns a session (non-null)", async () => {
      const latest = await client.getLatestSession(sandbox.name);
      expect(latest).not.toBeNull();
      expect(latest?.sandboxId).toBe(sandbox.id);
    });

    it("updateSession can mutate metadata", async () => {
      const updated = await client.updateSession(sandbox.name, sessionId, {
        metadata: { source: "ts-sdk-functional", updated: true },
      });
      expect(updated.id).toBe(sessionId);
      expect(updated.metadata["updated"]).toBe(true);
    });
  });

  describe("agent send", () => {
    it(
      "agentSend returns a response and a session id",
      async () => {
        const resp = await client.agentSend(sandbox.name, {
          message:
            "Reply with the single word 'ok' and nothing else. This is a functional test from the TypeScript SDK.",
          newSession: true,
          agent: TEST_AGENT_NAME,
        });
        expect(resp.sessionId).not.toBe("");
        expect(typeof resp.result).toBe("string");
        expect(resp.isError).toBe(false);
      },
      LONG_TIMEOUT_MS,
    );
  });

  // Mutates state — keep at the end so earlier read tests run against a running
  // sandbox.
  describe("stop / start lifecycle", () => {
    it(
      "stopSandbox + waitForSandboxStop transitions to stopped",
      async () => {
        await client.stopSandbox(sandbox.name);
        const stopped = await client.waitForSandboxStop(sandbox.name);
        expect(stopped.state).toBe("stopped");
      },
      LONG_TIMEOUT_MS,
    );

    it(
      "startSandbox + waitForSandboxStart returns to a ready state",
      async () => {
        await client.startSandbox(sandbox.name);
        const started = await client.waitForSandboxStart(sandbox.name);
        expect(["active", "running", "started"]).toContain(started.state);
      },
      LONG_TIMEOUT_MS,
    );
  });

  // Runs last so every preceding test still has a sandbox to talk to. The
  // afterAll registered by provisionSandbox is kept as a safety net for runs
  // where this test is skipped or fails before deleting.
  describe("delete", () => {
    it("deleteSandbox removes the sandbox", async () => {
      await client.deleteSandbox(sandbox.name);

      // After deletion the server either returns 404 from getSandbox or keeps
      // the record around briefly in a terminal "deleted"-style state. Accept
      // both, but require that listSandboxes no longer surfaces it as live.
      try {
        const sb = await client.getSandbox(sandbox.name);
        expect(sb.state).toMatch(/delet/i);
      } catch (err) {
        expect(err).toBeInstanceOf(AmikaHTTPError);
        expect((err as AmikaHTTPError).statusCode).toBe(404);
      }

      const all = await client.listSandboxes();
      const stillLive = all.find(
        (s) => s.name === sandbox.name && !/delet/i.test(s.state),
      );
      expect(stillLive).toBeUndefined();
    });
  });
});
