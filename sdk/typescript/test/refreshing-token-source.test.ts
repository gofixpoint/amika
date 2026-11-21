import { describe, expect, it, vi } from "vitest";
import { AmikaClient, AmikaError, refreshingTokenSource } from "@/index";
import { mockFetch } from "./helpers.js";

const T0 = Date.parse("2026-11-19T12:00:00Z");

function clock(start = T0) {
  let ms = start;
  return {
    now: () => ms,
    advance: (seconds: number) => {
      ms += seconds * 1000;
    },
  };
}

function tokens(...lifetimesSeconds: number[]) {
  let n = 0;
  return vi.fn(async (now: number) => {
    const life = lifetimesSeconds[Math.min(n, lifetimesSeconds.length - 1)]!;
    n += 1;
    return {
      token: `amk_pt_token_${n}`,
      expiresAt: new Date(now + life * 1000).toISOString(),
    };
  });
}

describe("refreshingTokenSource", () => {
  it("gets the next token before the current one expires (Q-G20)", async () => {
    // A token that expires in 30 seconds: the source refreshes it halfway.
    const c = clock();
    const fetchToken = tokens(30, 30);
    const source = refreshingTokenSource({
      fetchToken: () => fetchToken(c.now()),
      now: c.now,
    });

    expect(await source.token()).toBe("amk_pt_token_1");
    c.advance(10);
    expect(await source.token()).toBe("amk_pt_token_1");
    expect(fetchToken).toHaveBeenCalledTimes(1);

    c.advance(6); // 16s: past the halfway point, before expiry
    expect(await source.token()).toBe("amk_pt_token_2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes refreshBeforeSeconds before expiry for a long token", async () => {
    const c = clock();
    const fetchToken = tokens(3600, 3600);
    const source = refreshingTokenSource({
      fetchToken: () => fetchToken(c.now()),
      refreshBeforeSeconds: 60,
      now: c.now,
    });
    await source.token();
    c.advance(3539);
    expect(await source.token()).toBe("amk_pt_token_1");
    c.advance(2);
    expect(await source.token()).toBe("amk_pt_token_2");
  });

  it("makes one call for concurrent requests", async () => {
    const c = clock();
    const fetchToken = tokens(3600);
    const source = refreshingTokenSource({
      fetchToken: () => fetchToken(c.now()),
      now: c.now,
    });
    const all = await Promise.all([
      source.token(),
      source.token(),
      source.token(),
    ]);
    expect(all).toEqual(["amk_pt_token_1", "amk_pt_token_1", "amk_pt_token_1"]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("keeps a token that still works when a refresh fails", async () => {
    const c = clock();
    let fail = false;
    const fetchToken = tokens(30, 30);
    const source = refreshingTokenSource({
      fetchToken: async () => {
        if (fail) throw new Error("backend down");
        return fetchToken(c.now());
      },
      now: c.now,
    });
    await source.token();
    fail = true;
    c.advance(20); // past the refresh point, before expiry
    expect(await source.token()).toBe("amk_pt_token_1");
    c.advance(11); // expired
    await expect(source.token()).rejects.toThrow("backend down");
    fail = false;
    expect(await source.token()).toBe("amk_pt_token_2");
  });

  it("tries again after fetchToken throws before it returns a promise", async () => {
    let calls = 0;
    const source = refreshingTokenSource({
      fetchToken: () => {
        calls += 1;
        if (calls === 1) throw new Error("not ready");
        return Promise.resolve({
          token: "amk_pt_after",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
    });
    await expect(source.token()).rejects.toThrow("not ready");
    expect(await source.token()).toBe("amk_pt_after");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses refreshBeforeSeconds %s",
    (refreshBeforeSeconds) => {
      expect(() =>
        refreshingTokenSource({
          fetchToken: async () => ({ token: "t", expiresAt: new Date() }),
          refreshBeforeSeconds,
        }),
      ).toThrow(AmikaError);
    },
  );

  it("refuses a fetched token with no expiry", async () => {
    const source = refreshingTokenSource({
      fetchToken: async () => ({ token: "amk_pt_x", expiresAt: "not a date" }),
    });
    await expect(source.token()).rejects.toBeInstanceOf(AmikaError);
  });

  it("refuses a token that expired before the fetch returned", async () => {
    const c = clock();
    const stale = refreshingTokenSource({
      fetchToken: async () => ({
        token: "amk_pt_stale",
        expiresAt: new Date(c.now() - 1000).toISOString(),
      }),
      now: c.now,
    });
    await expect(stale.token()).rejects.toBeInstanceOf(AmikaError);

    // Valid when asked for, expired when the slow call returns.
    const slow = refreshingTokenSource({
      fetchToken: async () => {
        const expiresAt = new Date(c.now() + 5000).toISOString();
        c.advance(10);
        return { token: "amk_pt_slow", expiresAt };
      },
      now: c.now,
    });
    await expect(slow.token()).rejects.toBeInstanceOf(AmikaError);
  });

  it("sends the current token as the client's bearer", async () => {
    const c = clock();
    const fetchToken = tokens(30, 30);
    const { fetch, calls } = mockFetch([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    const client = new AmikaClient({
      baseUrl: "https://api.example.com",
      fetch,
      tokenSource: refreshingTokenSource({
        fetchToken: () => fetchToken(c.now()),
        now: c.now,
      }),
    });
    await client.rigs.list();
    c.advance(16);
    await client.rigs.list();
    expect(
      calls[0]?.headers.Authorization ?? calls[0]?.headers.authorization,
    ).toBe("Bearer amk_pt_token_1");
    expect(
      calls[1]?.headers.Authorization ?? calls[1]?.headers.authorization,
    ).toBe("Bearer amk_pt_token_2");
  });
});
