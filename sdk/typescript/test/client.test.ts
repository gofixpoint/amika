import { describe, it, expect } from "vitest";
import { AmikaClient, type AmikaClientOptions } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

describe("AmikaClient construction", () => {
  it("uses the production API URL when baseUrl is omitted", async () => {
    const { fetch, calls } = mockFetch([{ body: [] }]);

    await new AmikaClient({ apiKey: "key", fetch }).listRigs();

    expect(calls[0]?.url).toBe("https://app.amika.dev/api/v0beta1/rigs");
  });

  it.each([
    {},
    { apiKey: "key", accessToken: "token" },
    { apiKey: "key", tokenSource: { token: () => "token" } },
    { accessToken: "token", tokenSource: { token: () => "token" } },
    {
      apiKey: "key",
      accessToken: "token",
      tokenSource: { token: () => "token" },
    },
  ])("rejects conflicting or missing credentials: %j", (credentials) => {
    expect(
      () =>
        new AmikaClient({
          baseUrl: BASE,
          ...credentials,
        } as unknown as AmikaClientOptions),
    ).toThrow(/exactly one of apiKey, accessToken, or tokenSource/);
  });

  it.each([
    { apiKey: "" },
    { apiKey: "   " },
    { accessToken: "" },
    { accessToken: "\t" },
    { apiKey: null },
    { accessToken: 123 },
  ])("rejects empty or invalid static credentials: %j", (credentials) => {
    expect(
      () =>
        new AmikaClient({
          baseUrl: BASE,
          ...credentials,
        } as unknown as AmikaClientOptions),
    ).toThrow(/non-empty string/);
  });

  it.each([null, {}, { token: "invalid" }])(
    "rejects an invalid token source: %j",
    (tokenSource) => {
      expect(
        () =>
          new AmikaClient({
            baseUrl: BASE,
            tokenSource,
          } as unknown as AmikaClientOptions),
      ).toThrow(/tokenSource must provide a token/);
    },
  );

  it.each([
    { apiKey: "key" },
    { accessToken: "key" },
    { tokenSource: { token: async () => "key" } },
  ])("sends the selected credential as a bearer token", async (credentials) => {
    const { fetch, calls } = mockFetch([{ body: [] }]);
    await new AmikaClient({ baseUrl: BASE, ...credentials, fetch }).listRigs();
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer key");
  });

  it("rejects missing and conflicting credentials at compile time too", () => {
    // @ts-expect-error A credential source is required.
    const missing: AmikaClientOptions = { baseUrl: BASE };
    // @ts-expect-error Static credentials are mutually exclusive.
    const both: AmikaClientOptions = {
      baseUrl: BASE,
      apiKey: "key",
      accessToken: "token",
    };
    // @ts-expect-error tokenSource cannot accompany a static credential.
    const source: AmikaClientOptions = {
      baseUrl: BASE,
      apiKey: "key",
      tokenSource: { token: () => "key" },
    };
    expect([missing, both, source]).toHaveLength(3);
  });
});
