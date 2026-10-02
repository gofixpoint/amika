import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/index";
import { AmikaHTTPError } from "@/index";
import type { RemoteRig } from "@/index";

import {
  describeFunctional,
  ensureGitHubToken,
  LONG_TIMEOUT_MS,
  makeClient,
  provisionRig,
  resolveAgentCredential,
  TEST_AGENT_NAME,
} from "@test/functional/helpers";

describeFunctional("rig functional tests", () => {
  let client: AmikaClient;
  let rig: RemoteRig;

  beforeAll(async () => {
    client = makeClient();
    await ensureGitHubToken(client);

    const credential = await resolveAgentCredential(client);

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
      expect(rig.status).toBe("running");
      expect(rig.createdAt).not.toBe("");
    });
  });

  describe("read operations", () => {
    it("getRig returns the provisioned rig in a ready state", async () => {
      const got = await client.getRig(rig.name);
      expect(got.name).toBe(rig.name);
      expect(got.id).toBe(rig.id);
      expect(got.status).toBe("running");
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
        expect(typeof resp.response).toBe("string");
        expect(resp.isError).toBe(false);

        const onRig = await client.agentSessions.list({ rig: rig.name });
        expect(onRig.sessions.some((s) => s.sessionId === resp.sessionId)).toBe(
          true,
        );
        expect(onRig.sessions.every((s) => s.sandboxId === rig.id)).toBe(true);
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
        expect(stopped.status).toBe("stopped");
      },
      LONG_TIMEOUT_MS,
    );

    it(
      "startRig + waitForRigStart returns to a ready state",
      async () => {
        await client.startRig(rig.name);
        const started = await client.waitForRigStart(rig.name);
        expect(started.status).toBe("running");
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
