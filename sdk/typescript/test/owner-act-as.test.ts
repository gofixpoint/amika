import { describe, it, expect } from "vitest";
import { AmikaClient, AmikaError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch, actAs?: string): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    apiKey: "key",
    fetch: fetchImpl,
    ...(actAs === undefined ? {} : { actAs }),
  });
}

describe("rig and snapshot owners", () => {
  it("reads the owner of each rig", async () => {
    const { fetch } = mockFetch([
      {
        body: [
          { id: "1", name: "a", owner: { kind: "org" } },
          {
            id: "2",
            name: "b",
            owner: { kind: "end_user", external_id: "u_1" },
          },
          { id: "3", name: "c" },
          { id: "4", name: "d", owner: { kind: "team" } },
        ],
      },
    ]);
    const rigs = await makeClient(fetch).rigs.list({ owner: "any" });
    expect(rigs.map((r) => r.owner)).toEqual([
      { kind: "org" },
      { kind: "end_user", externalId: "u_1" },
      undefined,
      undefined,
    ]);
  });

  it("sends the owner filter on rig and snapshot lists only when set", async () => {
    const { fetch, calls } = mockFetch([
      { body: [] },
      { body: [] },
      { body: { items: [] } },
      { body: { items: [] } },
    ]);
    const client = makeClient(fetch);
    await client.rigs.list();
    await client.rigs.list({ owner: "end_user" });
    await client.snapshots.list();
    await client.snapshots.list({ owner: "any" });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/v0beta1/rigs`,
      `${BASE}/api/v0beta1/rigs?owner=end_user`,
      `${BASE}/api/v0beta1/rig-snapshots`,
      `${BASE}/api/v0beta1/rig-snapshots?owner=any`,
    ]);
  });

  it("reads the owner of a snapshot", async () => {
    const { fetch } = mockFetch([
      {
        body: {
          items: [
            {
              id: "s1",
              snapshot: "snap",
              owner: { kind: "end_user", external_id: "u_2" },
            },
          ],
        },
      },
    ]);
    const [snap] = await makeClient(fetch).snapshots.list();
    expect(snap?.owner).toEqual({ kind: "end_user", externalId: "u_2" });
  });
});

describe("acting as an end-user", () => {
  it("sends Amika-As-Principal on every request when actAs is set", async () => {
    const { fetch, calls } = mockFetch([{ body: [] }, { body: [] }]);
    const client = makeClient(fetch, "end_user:u_1");
    await client.rigs.list();
    await client.rigs.list();
    expect(calls.map((c) => c.headers["Amika-As-Principal"])).toEqual([
      "end_user:u_1",
      "end_user:u_1",
    ]);
  });

  it("sends no Amika-As-Principal without actAs", async () => {
    const { fetch, calls } = mockFetch([{ body: [] }]);
    await makeClient(fetch).rigs.list();
    expect(calls[0]?.headers["Amika-As-Principal"]).toBeUndefined();
  });

  it("actAs() returns a new client and leaves the original unchanged", async () => {
    const { fetch, calls } = mockFetch([{ body: [] }, { body: [] }]);
    const org = makeClient(fetch);
    const asUser = org.actAs("end_user:u_9");
    await asUser.rigs.list();
    await org.rigs.list();
    expect(calls[0]?.headers["Amika-As-Principal"]).toBe("end_user:u_9");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer key");
    expect(calls[1]?.headers["Amika-As-Principal"]).toBeUndefined();
  });

  it("refuses an empty actAs before any request", () => {
    const { fetch } = mockFetch([]);
    expect(() => makeClient(fetch, " ")).toThrow(AmikaError);
    expect(() => makeClient(fetch).actAs("")).toThrow(AmikaError);
  });
});
