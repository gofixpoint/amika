import { describe, it, expect } from "vitest";
import { AmikaClient, AmikaError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

const accountWire = {
  id: "cacc_1",
  provider: "instabox",
  name: "prod",
  is_default: true,
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-13T00:00:00Z",
};

describe("client.cloudAccounts", () => {
  it("create POSTs the snake_case body and decodes the account", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: accountWire }]);
    const account = await makeClient(fetch).cloudAccounts.create({
      provider: "instabox",
      name: "prod",
      apiKey: "ib_secret",
      isDefault: true,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/cloud-accounts`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      provider: "instabox",
      name: "prod",
      api_key: "ib_secret",
      is_default: true,
    });
    expect(account).toEqual({
      id: "cacc_1",
      provider: "instabox",
      name: "prod",
      isDefault: true,
      createdAt: "2026-11-12T00:00:00Z",
      updatedAt: "2026-11-13T00:00:00Z",
    });
  });

  it("create omits isDefault when it is not given", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: accountWire }]);
    await makeClient(fetch).cloudAccounts.create({
      provider: "e2b",
      name: "prod",
      apiKey: "k",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      provider: "e2b",
      name: "prod",
      api_key: "k",
    });
  });

  it("list unwraps items and sends the provider filter", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [accountWire] } },
      { status: 200, body: { items: [] } },
    ]);
    const client = makeClient(fetch);
    const accounts = await client.cloudAccounts.list({ provider: "instabox" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/cloud-accounts?provider=instabox`,
    );
    expect(accounts.map((a) => a.id)).toEqual(["cacc_1"]);
    expect(await client.cloudAccounts.list()).toEqual([]);
    expect(calls[1]?.url).toBe(`${BASE}/api/v0beta1/cloud-accounts`);
  });

  it("get sends a plain string without by, and a pinned kind as by", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: accountWire },
      { status: 200, body: accountWire },
      { status: 200, body: accountWire },
    ]);
    const client = makeClient(fetch);
    await client.cloudAccounts.get("prod");
    await client.cloudAccounts.get({ ref: "cacc_1", by: "id" });
    await client.cloudAccounts.get(
      { ref: "prod", by: "name" },
      { provider: "instabox" },
    );
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/cloud-accounts/prod`);
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v0beta1/cloud-accounts/cacc_1?by=id`,
    );
    expect(calls[2]?.url).toBe(
      `${BASE}/api/v0beta1/cloud-accounts/prod?by=name&provider=instabox`,
    );
  });

  it("update PATCHes only the given fields", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { ...accountWire, is_default: false } },
    ]);
    const account = await makeClient(fetch).cloudAccounts.update(
      "prod",
      { isDefault: false, apiKey: "new" },
      { provider: "instabox" },
    );
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/cloud-accounts/prod?provider=instabox`,
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      api_key: "new",
      is_default: false,
    });
    expect(account.isDefault).toBe(false);
  });

  it("delete sends DELETE", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    await makeClient(fetch).cloudAccounts.delete(
      { ref: "cacc_1", by: "id" },
      { provider: "instabox" },
    );
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/cloud-accounts/cacc_1?by=id&provider=instabox`,
    );
  });

  it("rejects an empty account reference before any request", async () => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    await expect(client.cloudAccounts.get(" ")).rejects.toBeInstanceOf(
      AmikaError,
    );
    await expect(
      client.cloudAccounts.delete({ ref: "", by: "name" }),
    ).rejects.toThrow("cloud account must not be empty");
    expect(calls).toHaveLength(0);
  });
});
