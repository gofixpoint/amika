import { afterEach, describe, expect, it, vi } from "vitest";
import createInstaboxProvider from "../provider";
import { listInstaboxSizes } from "./account";

const CONFIG = { apiKey: "ibk_test", apiUrl: "https://ib.test" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/** Answer `GET /v1/me` with `body`; return each request as "METHOD path key". */
function stubMe(body: unknown): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const path = new URL(url).pathname;
      const key = new Headers(init.headers).get("X-API-Key");
      requests.push(`${method} ${path} ${key}`);
      if (method === "GET" && path === "/v1/me") return json(200, body);
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
  return requests;
}

const PRO_SPECS = [
  { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
  { vcpus: 2, memMiB: 4096, persistentDiskGiB: 20 },
  { vcpus: 8, memMiB: 16384, persistentDiskGiB: 20 },
];

describe("listInstaboxSizes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the key's sizes in GiB, the default first", async () => {
    const requests = stubMe({ userId: 1, login: "a", allowedSpecs: PRO_SPECS });

    await expect(listInstaboxSizes(CONFIG)).resolves.toEqual([
      { vcpus: 4, memoryGib: 8, diskGib: 20 },
      { vcpus: 2, memoryGib: 4, diskGib: 20 },
      { vcpus: 8, memoryGib: 16, diskGib: 20 },
    ]);
    expect(requests).toEqual(["GET /v1/me ibk_test"]);
  });

  it("is the provider's account sizes", async () => {
    stubMe({ allowedSpecs: PRO_SPECS.slice(0, 1) });
    const provider = createInstaboxProvider(CONFIG);

    expect(provider.capabilities.accountSizes).toBe(true);
    await expect(provider.account!.sizes()).resolves.toEqual([
      { vcpus: 4, memoryGib: 8, diskGib: 20 },
    ]);
  });

  it.each([
    ["no sizes", { allowedSpecs: [] }],
    ["no allowedSpecs", { userId: 1, login: "a" }],
    [
      "a size without memory",
      { allowedSpecs: [{ vcpus: 4, persistentDiskGiB: 20 }] },
    ],
  ])("refuses an answer with %s", async (_, body) => {
    stubMe(body);

    await expect(listInstaboxSizes(CONFIG)).rejects.toThrow();
  });
});
