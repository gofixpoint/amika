import { createVerify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gcpAccessToken,
  parseGcpCredentials,
  signedAssertion,
} from "./credentials";
import { TEST_CONFIG, TEST_KEY_JSON, TEST_PUBLIC_KEY } from "./test-key";

afterEach(() => vi.unstubAllGlobals());

describe("parseGcpCredentials", () => {
  it("reads the project from the key and defaults the zone", () => {
    const creds = parseGcpCredentials(TEST_CONFIG);
    expect(creds.projectId).toBe("acme-proj");
    expect(creds.zone).toBe("us-central1-a");
  });

  it("accepts the key in base64", () => {
    const apiKey = Buffer.from(JSON.stringify(TEST_KEY_JSON)).toString(
      "base64",
    );
    expect(parseGcpCredentials({ apiKey }).projectId).toBe("acme-proj");
  });

  it("lets a zone in the key win over the config zone", () => {
    const apiKey = JSON.stringify({ ...TEST_KEY_JSON, zone: "europe-west1-b" });
    expect(parseGcpCredentials({ apiKey, zone: "us-east1-c" }).zone).toBe(
      "europe-west1-b",
    );
    expect(
      parseGcpCredentials({ ...TEST_CONFIG, zone: "us-east1-c" }).zone,
    ).toBe("us-east1-c");
  });

  it("refuses a bad zone name", () => {
    expect(() =>
      parseGcpCredentials({ ...TEST_CONFIG, zone: "us-central1" }),
    ).toThrow(/not a Compute Engine zone/);
  });

  it("refuses text that is not a key, without repeating it", () => {
    expect(() => parseGcpCredentials({ apiKey: "s3cret-value" })).toThrow(
      /not JSON/,
    );
    const err = (() => {
      try {
        parseGcpCredentials({ apiKey: '{"type":"user","secret":"s3cret"}' });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/not a service account JSON key/);
    expect(err?.message).not.toContain("s3cret");
  });
});

describe("signedAssertion", () => {
  it("is a JWT signed with the key, for the compute scope", () => {
    const creds = parseGcpCredentials(TEST_CONFIG);
    const jwt = signedAssertion(creds, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: TEST_KEY_JSON.client_email,
      scope: "https://www.googleapis.com/auth/compute",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(TEST_PUBLIC_KEY, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("gcpAccessToken", () => {
  it("trades the assertion for a token and reuses it", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok-1", expires_in: 3600 }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const creds = parseGcpCredentials({
      apiKey: JSON.stringify({ ...TEST_KEY_JSON, client_email: "reuse@x" }),
    });
    expect(await gcpAccessToken(creds)).toBe("tok-1");
    expect(await gcpAccessToken(creds)).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Never the key's own `token_uri`, which is customer input.
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://oauth2.googleapis.com/token",
      expect.anything(),
    ]);
    const body = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
  });

  it("names Google's refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      ),
    );
    const creds = parseGcpCredentials({
      apiKey: JSON.stringify({ ...TEST_KEY_JSON, client_email: "refused@x" }),
    });
    await expect(gcpAccessToken(creds)).rejects.toThrow(/invalid_grant/);
  });
});
