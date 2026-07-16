import { beforeAll, describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";

import {
  describeFunctional,
  makeClient,
  uniqueSuffix,
} from "@test/functional/helpers";

describeFunctional("secrets functional tests", () => {
  let client: AmikaClient;

  beforeAll(() => {
    client = makeClient();
  });

  describe("secrets", () => {
    // Secrets API has no delete endpoint, so test-created secrets persist.
    // Use a unique name per run so successive runs don't collide.
    const secretName = `TS_SDK_FN_${uniqueSuffix()}`.toUpperCase();
    let secretId: string;

    it("createSecret + listSecrets surfaces the new secret", async () => {
      await client.createSecret({
        name: secretName,
        value: "initial-value",
        scope: "user",
      });
      const secrets = await client.listSecrets();
      const created = secrets.find((s) => s.name === secretName);
      expect(created).toBeDefined();
      expect(created?.scope).toBe("user");
      secretId = created!.id;
      expect(secretId).not.toBe("");
    });

    it("updateSecret accepts a new value", async () => {
      // No GET-by-id endpoint, so the assertion is just that the call succeeds
      // (mirrors the Go SDK's coverage).
      await client.updateSecret(secretId, { value: "rotated-value" });
    });
  });

  describe("provider secrets", () => {
    // The provider field is part of the URL; "claude" matches the API path used
    // by the CLI's provider-secret commands (see go/cmd/amika/secrets.go).
    const provider = process.env["AMIKA_TEST_PROVIDER"] ?? "claude";
    const credName = `ts-sdk-fn-${uniqueSuffix()}`;
    // Some servers validate the value against the upstream provider before
    // storing it, so a real key may be required. Set
    // AMIKA_TEST_PROVIDER_SECRET_VALUE (e.g. via `op run`) to inject one;
    // otherwise the placeholder is sent, which is fine on servers that skip
    // validation.
    const secretValue =
      process.env["AMIKA_TEST_PROVIDER_SECRET_VALUE"] ??
      "sk-fake-functional-test-value";

    it("create + list + delete provider secret round-trips", async () => {
      const summary = await client.createProviderSecret(provider, {
        name: credName,
        value: secretValue,
        type: "api_key",
      });
      expect(summary.name).toBe(credName);
      expect(summary.id).not.toBe("");

      try {
        const items = await client.listProviderSecrets(provider);
        const found = items.find((i) => i.id === summary.id);
        expect(found).toBeDefined();
        expect(found?.name).toBe(credName);
        expect(found?.type).toBe("api_key");
      } finally {
        await client.deleteProviderSecret(provider, summary.id);
      }

      const after = await client.listProviderSecrets(provider);
      expect(after.some((i) => i.id === summary.id)).toBe(false);
    });
  });
});
