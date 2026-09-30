import { describe, it, expect } from "vitest";
import { AmikaClient } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

describe("AmikaClient secrets", () => {
  it("listSecrets decodes the full summary", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [
          {
            id: "1",
            org_id: "org_1",
            user_id: "usr_1",
            name: "API_KEY",
            description: null,
            scope: "user",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
        ],
      },
    ]);
    const client = makeClient(fetch);
    const secrets = await client.listSecrets();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets`);
    expect(secrets[0]).toEqual({
      id: "1",
      orgId: "org_1",
      userId: "usr_1",
      name: "API_KEY",
      description: null,
      scope: "user",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("listSecrets returns [] when the server sends no body", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "" }]);
    expect(await makeClient(fetch).listSecrets()).toEqual([]);
  });

  it("createProviderSecret forwards an explicit scope", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: { id: "1", name: "work", scope: "org" } },
    ]);
    await makeClient(fetch).createProviderSecret("claude", {
      name: "work",
      value: "sk-…",
      type: "api_key",
      scope: "org",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "work",
      value: "sk-…",
      type: "api_key",
      scope: "org",
    });
  });

  it("createSecret POSTs the request body", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: "" }]);
    const client = makeClient(fetch);
    await client.createSecret({ name: "API_KEY", value: "v", scope: "user" });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "API_KEY",
      value: "v",
      scope: "user",
    });
  });

  it("updateSecret PUTs to /secrets/{id}", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.updateSecret("abc", { value: "newval" });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/abc`);
  });

  it("createProviderSecret POSTs to /secrets/{provider}", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { id: "1", name: "personal", scope: "user" } },
    ]);
    const client = makeClient(fetch);
    const summary = await client.createProviderSecret("claude", {
      name: "personal",
      value: "v",
      type: "oauth",
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/claude`);
    expect(summary.name).toBe("personal");
  });

  it("deleteProviderSecret hits /secrets/{provider}/{id}", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteProviderSecret("claude", "abc");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/claude/abc`);
  });
});
