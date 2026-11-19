import { describe, expect, it } from "vitest";
import { AmikaClient, AmikaError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({ baseUrl: BASE, apiKey: "sk_act", fetch: fetchImpl });
}

describe("client.principalTokens", () => {
  it("mint POSTs the snake_case body and decodes the token", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 201,
        body: {
          id: "pt_1",
          token: "amk_pt_b3Jn.abc",
          expires_at: "2026-11-19T13:00:00.000Z",
        },
      },
    ]);
    const minted = await makeClient(fetch).principalTokens.mint({
      principal: "end_user:u_123",
      ttlSeconds: 600,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/iam/principal-tokens`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      principal: "end_user:u_123",
      ttl_seconds: 600,
    });
    expect(minted).toEqual({
      id: "pt_1",
      token: "amk_pt_b3Jn.abc",
      expiresAt: "2026-11-19T13:00:00.000Z",
    });
  });

  it("mint omits ttl_seconds when it is not given", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: { id: "pt_1", token: "t", expires_at: "x" } },
    ]);
    await makeClient(fetch).principalTokens.mint({ principal: "end_user:u" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      principal: "end_user:u",
    });
  });

  it("revoke DELETEs the encoded id", async () => {
    const { fetch, calls } = mockFetch([{ status: 204 }]);
    await makeClient(fetch).principalTokens.revoke("pt_a/b");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/iam/principal-tokens/pt_a%2Fb`,
    );
  });

  it("revoke refuses an empty id before any request", async () => {
    const { fetch, calls } = mockFetch([]);
    await expect(
      makeClient(fetch).principalTokens.revoke(" "),
    ).rejects.toBeInstanceOf(AmikaError);
    expect(calls).toHaveLength(0);
  });
});
