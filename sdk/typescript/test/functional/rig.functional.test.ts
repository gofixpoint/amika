import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";
import { AmikaHTTPError } from "@/errors";
import type { AgentCredentialRef, RemoteRig } from "@/types";

import {
  describeFunctional,
  ensureGitHubToken,
  LONG_TIMEOUT_MS,
  makeClient,
  provisionRig,
  TEST_AGENT_NAME,
} from "@test/functional/helpers";

const ENV_CRED_NAME = process.env["AMIKA_TEST_AGENT_CREDENTIAL_NAME"];
const ENV_CRED_TYPE = (process.env["AMIKA_TEST_AGENT_CREDENTIAL_TYPE"] ??
  "api_key") as "oauth" | "api_key";

describeFunctional("rig functional tests", () => {
  let client: AmikaClient;
  let rig: RemoteRig;

  beforeAll(async () => {
    client = makeClient();
    await ensureGitHubToken(client);

    let credential: AgentCredentialRef;
    if (ENV_CRED_NAME) {
      // Explicit env override takes precedence.
      credential = {
        kind: TEST_AGENT_NAME,
        name: ENV_CRED_NAME,
        type: ENV_CRED_TYPE,
      };
    } else {
      // Default: require an existing api_key on the org; fail fast if none.
      const secrets = await client.listProviderSecrets(TEST_AGENT_NAME);
      const apiKeySecret = secrets.find((s) => s.type === "api_key");
      if (!apiKeySecret) {
        throw new Error(
          `No api_key credential found for provider "${TEST_AGENT_NAME}". ` +
            "Add one before running the functional suite.",
        );
      }
      credential = {
        kind: TEST_AGENT_NAME,
        type: "api_key",
        ...(apiKeySecret.name ? { name: apiKeySecret.name } : {}),
      };
    }

    rig = await provisionRig(client, {
      agentCredentials: [credential],
    });
  }, LONG_TIMEOUT_MS);

  describe("provisioning", () => {
    it("createRig + waitForRig returned a ready rig", () => {
      // The actual API calls happened in beforeAll via provisionRig; this
      // test makes the assertion explicit so a failure points at the right
      // method instead of cascading into every other test.
      expect(rig.id).not.toBe("");
      expect(rig.name).not.toBe("");
      expect(["active", "running", "started"]).toContain(rig.state);
      expect(rig.createdAt).not.toBe("");
    });
  });

  describe("read operations", () => {
    it("getRig returns the provisioned rig in a ready state", async () => {
      const got = await client.getRig(rig.name);
      expect(got.name).toBe(rig.name);
      expect(got.id).toBe(rig.id);
      expect(["active", "running", "started"]).toContain(got.state);
      // repo_url is nullable in the schema; created_at is required.
      expect(got.repoUrl === null || typeof got.repoUrl === "string").toBe(
        true,
      );
      expect(typeof got.createdAt).toBe("string");
    });

    it("listRigs includes the provisioned rig", async () => {
      const all = await client.listRigs();
      const match = all.find((r) => r.name === rig.name);
      expect(match).toBeDefined();
      expect(match?.id).toBe(rig.id);
    });

    it("the legacy sandbox aliases reach the same rig", async () => {
      const viaAlias = await client.getSandbox(rig.name);
      expect(viaAlias.id).toBe(rig.id);
      const all = await client.listSandboxes();
      expect(all.some((r) => r.id === rig.id)).toBe(true);
    });
  });

  describe("sessions", () => {
    let sessionId: string;

    it("createSession returns a session for the configured agent", async () => {
      const session = await client.createSession(rig.name, {
        agentName: TEST_AGENT_NAME,
        metadata: { source: "ts-sdk-functional" },
      });
      expect(session.id).not.toBe("");
      expect(session.agentName).toBe(TEST_AGENT_NAME);
      expect(session.sandboxId).toBe(rig.id);
      sessionId = session.id;
    });

    it("listSessions returns the created session in the envelope", async () => {
      const sessions = await client.listSessions(rig.name);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
    });

    it("getSession returns the session by id", async () => {
      const session = await client.getSession(rig.name, sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.sandboxId).toBe(rig.id);
    });

    it("getLatestSession returns a session (non-null)", async () => {
      const latest = await client.getLatestSession(rig.name);
      expect(latest).not.toBeNull();
      expect(latest?.sandboxId).toBe(rig.id);
    });

    it("updateSession can mutate metadata", async () => {
      const updated = await client.updateSession(rig.name, sessionId, {
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
        const resp = await client.agentSend(rig.name, {
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
  // rig.
  describe("stop / start lifecycle", () => {
    it(
      "stopRig + waitForRigStop transitions to stopped",
      async () => {
        await client.stopRig(rig.name);
        const stopped = await client.waitForRigStop(rig.name);
        expect(stopped.state).toBe("stopped");
      },
      LONG_TIMEOUT_MS,
    );

    it(
      "startRig + waitForRigStart returns to a ready state",
      async () => {
        await client.startRig(rig.name);
        const started = await client.waitForRigStart(rig.name);
        expect(["active", "running", "started"]).toContain(started.state);
      },
      LONG_TIMEOUT_MS,
    );
  });

  // Runs last so every preceding test still has a rig to talk to. The
  // afterAll registered by provisionRig is kept as a safety net for runs
  // where this test is skipped or fails before deleting.
  describe("delete", () => {
    it("deleteRig removes the rig", async () => {
      await client.deleteRig(rig.name);

      // After deletion the server either returns 404 from getRig or keeps
      // the record around briefly in a terminal "deleted"-style state. Accept
      // both, but require that listRigs no longer surfaces it as live.
      try {
        const got = await client.getRig(rig.name);
        expect(got.state).toMatch(/delet/i);
      } catch (err) {
        expect(err).toBeInstanceOf(AmikaHTTPError);
        expect((err as AmikaHTTPError).statusCode).toBe(404);
      }

      const all = await client.listRigs();
      const stillLive = all.find(
        (r) => r.name === rig.name && !/delet/i.test(r.state),
      );
      expect(stillLive).toBeUndefined();
    });
  });
});
