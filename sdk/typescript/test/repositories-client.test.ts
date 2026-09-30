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

describe("AmikaClient.listRepositories", () => {
  it("GETs /repositories and maps repo_url", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [{ id: "r_1", repo_url: "git@github.com:o/p.git" }],
      },
    ]);
    const repos = await makeClient(fetch).listRepositories();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/repositories`);
    expect(repos).toEqual([{ id: "r_1", repoUrl: "git@github.com:o/p.git" }]);
  });

  it("returns [] when the server sends no body", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "" }]);
    expect(await makeClient(fetch).listRepositories()).toEqual([]);
  });
});
