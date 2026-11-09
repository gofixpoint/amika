/**
 * Cover the gateway's login pieces below the server (what it stores and
 * claims), its preview decisions, and its cache-control rule.
 */
import { describe, expect, it } from "vitest";
import { signServiceToken, signSession } from "../credentials";
import {
  browserOrigin,
  hardenPreviewResponse,
  privateCacheControl,
  startLogin,
  usedLoginStates,
} from "./browser-login";
import { createGateway } from "./gateway";
import type { GatewayRequest } from "./routes";

const SECRET = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://preview.example";
const AMIKA = "https://app.amika.test";
const gateway = createGateway({
  secretKey: SECRET,
  isOwnPath: (pathname) => pathname.startsWith("/v0beta1/"),
  amikaUrl: AMIKA,
});

function request(
  path: string,
  headers: Record<string, string> = {},
  { origin = ORIGIN, method = "GET" } = {},
): GatewayRequest {
  return {
    method,
    url: new URL(`${origin}${path}`),
    headers: new Headers(headers),
  };
}

const session = async (origin = ORIGIN, nowS?: number) =>
  `__Host-amika-session=${await signSession(SECRET, { origin, user: "u" }, nowS)}`;
const PAGE_LOAD = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };

describe("previews", () => {
  it("forwards a preview with a session, setting its cookie on a page load", async () => {
    const decision = await gateway.authorize(
      request("/v0beta1/rigs/demo/previews/web/docs", {
        ...PAGE_LOAD,
        Cookie: await session(),
      }),
    );
    expect(decision).toMatchObject({
      kind: "forward",
      surface: "preview",
      route: { machine: "demo", service: "web", path: "/docs" },
      // And ends a retired service link's cookie, which nothing reads now.
      setCookies: [
        expect.stringMatching(/^__Host-amika-preview=demo\/web; /),
        expect.stringMatching(/^__Host-amika-service-link=; .*Max-Age=0/),
      ],
    });
  });

  // The session is Lax, which a sibling subdomain counts as the same site.
  it.each([
    ["a sibling subdomain's post", { "Sec-Fetch-Site": "same-site" }, "POST"],
    ["another site's fetch", { "Sec-Fetch-Site": "cross-site" }, "GET"],
    ["a request with no fetch metadata", {}, "GET"],
  ])("refuses %s, session or not", async (_label, headers, method) => {
    expect(
      await gateway.authorize(
        request(
          "/v0beta1/rigs/demo/previews/web/api/delete",
          { ...headers, Cookie: await session() },
          { method },
        ),
      ),
    ).toEqual({ kind: "refuse", surface: "preview", status: 403 });
  });

  it("serves a page load another site starts, as Amika opens a preview", async () => {
    expect(
      await gateway.authorize(
        request("/v0beta1/rigs/demo/previews/web/", {
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
          Cookie: await session(),
        }),
      ),
    ).toMatchObject({ kind: "forward", surface: "preview" });
  });

  it("lets an upgrade through only from this origin's own page", async () => {
    const upgrade = async (origin?: string) =>
      gateway.authorize(
        request("/v0beta1/rigs/demo/previews/web/hmr", {
          Cookie: await session(),
          "Sec-Fetch-Site": "same-origin",
          ...(origin ? { Origin: origin } : {}),
        }),
        { upgrade: true },
      );
    expect(await upgrade(ORIGIN)).toMatchObject({
      kind: "forward",
      setCookies: [],
    });
    expect(await upgrade("https://evil.preview.example")).toMatchObject({
      kind: "refuse",
      status: 403,
    });
    expect(await upgrade()).toMatchObject({ kind: "refuse", status: 403 });
  });

  it("sends a page load without a session to log in and back", async () => {
    expect(
      await gateway.authorize(
        request("/v0beta1/rigs/demo/previews/web/docs?x=1", PAGE_LOAD),
      ),
    ).toEqual({
      kind: "login",
      location: `/__amika/login?return=${encodeURIComponent("/v0beta1/rigs/demo/previews/web/docs?x=1")}`,
    });
  });

  // Once a session expires, a reload of a root-relative page must not get
  // stuck on 401: it logs in again and returns to the same guest path,
  // through the preview's own, as the Strict preview cookie is not sent on
  // the redirect back from Amika's site.
  it("sends a cookie-routed page load whose session expired to log in", async () => {
    const expired = await session(ORIGIN, 1_000_000);
    expect(
      await gateway.authorize(
        request("/docs", {
          ...PAGE_LOAD,
          Cookie: `${expired}; __Host-amika-preview=demo/web`,
          "Sec-Fetch-Site": "same-origin",
        }),
      ),
    ).toEqual({
      kind: "login",
      location: `/__amika/login?return=${encodeURIComponent("/v0beta1/rigs/demo/previews/web/docs")}`,
    });
  });

  it("refuses anything but a page load without a session, upgrades included", async () => {
    const path = "/v0beta1/rigs/demo/previews/web/api";
    expect(await gateway.authorize(request(path))).toMatchObject({
      kind: "refuse",
      surface: "preview",
      status: 401,
    });
    expect(
      await gateway.authorize(request(path, PAGE_LOAD), { upgrade: true }),
    ).toMatchObject({ kind: "refuse", status: 401 });
  });

  it("routes a root-relative URL by the preview cookie, with the session", async () => {
    const decision = await gateway.authorize(
      request("/@vite/client", {
        Cookie: `${await session()}; __Host-amika-preview=demo/web`,
        "Sec-Fetch-Site": "same-origin",
      }),
    );
    expect(decision).toMatchObject({
      kind: "forward",
      surface: "preview",
      route: { path: "/@vite/client" },
      setCookies: [],
    });
  });

  it("renews the preview cookie on a page load it routes", async () => {
    const decision = await gateway.authorize(
      request("/docs", {
        ...PAGE_LOAD,
        Cookie: `${await session()}; __Host-amika-preview=demo/web`,
        "Sec-Fetch-Site": "same-origin",
      }),
    );
    expect(decision).toMatchObject({
      kind: "forward",
      route: { path: "/docs" },
      setCookies: [
        expect.stringMatching(/^__Host-amika-preview=demo\/web; /),
        expect.stringMatching(/^__Host-amika-service-link=; .*Max-Age=0/),
      ],
    });
  });

  // A page's own script could set the cookie to anything.
  it.each(["demo/%2E", "demo/%2e%2e", "demo/amikad"])(
    "routes nothing by a preview cookie of %j",
    async (value) => {
      expect(
        await gateway.authorize(
          request("/docs", {
            ...PAGE_LOAD,
            Cookie: `${await session()}; __Host-amika-preview=${value}`,
            "Sec-Fetch-Site": "same-origin",
          }),
        ),
      ).toEqual({ kind: "not-mine" });
    },
  );

  it("routes by the preview cookie whatever retired link cookie is held", async () => {
    const decision = await gateway.authorize(
      request("/x", {
        Cookie: `__Host-amika-service-link=demo/api/1791417600.sig; ${await session()}; __Host-amika-preview=demo/web`,
        "Sec-Fetch-Site": "same-origin",
      }),
    );
    expect(decision).toMatchObject({
      kind: "forward",
      surface: "preview",
      route: { service: "web" },
    });
  });

  it("refuses a session from another origin", async () => {
    expect(
      await gateway.authorize(
        request("/v0beta1/rigs/demo/previews/web/", {
          Cookie: await session("https://other.example"),
        }),
      ),
    ).toMatchObject({ kind: "refuse", status: 401 });
  });

  it("has no preview of amikad", async () => {
    expect(
      await gateway.authorize(
        request("/v0beta1/rigs/demo/previews/amikad/", {
          Cookie: await session(),
        }),
      ),
    ).toEqual({ kind: "not-mine" });
  });

  it("serves no previews without Amika's URL", async () => {
    const plain = createGateway({
      secretKey: SECRET,
      isOwnPath: () => false,
    });
    expect(plain.servesPreviews).toBe(false);
    expect(
      plain.claims(request("/v0beta1/rigs/demo/previews/web/", PAGE_LOAD)),
    ).toBe(false);
  });

  it("strips every gateway cookie from what the guest gets", () => {
    expect(
      gateway.guestCookies(
        "a=1; __Host-amika-session=s; __Host-amika-preview=p; __Host-amika-login=l; b=2",
      ),
    ).toBe("a=1; b=2");
  });
});

describe("a request named by its hostname", () => {
  const NAMED_ORIGIN = "https://web--demo.r.acme.o.amika.test";
  const NAMED = { machine: "demo", service: "web" };

  /** A request that reached the service at its own name. */
  function named(
    path: string,
    headers: Record<string, string> = {},
    { method = "GET", origin = NAMED_ORIGIN } = {},
  ): GatewayRequest {
    return { ...request(path, headers, { origin, method }), named: NAMED };
  }

  it("is the service's whatever its path, the API's included", () => {
    for (const path of ["/", "/app", "/v0beta1/rigs", "/health"]) {
      expect(gateway.claims(named(path))).toBe(true);
    }
  });

  it("forwards a browser with a session for this origin, path untouched", async () => {
    const decision = await gateway.authorize(
      named("/v0beta1/rigs?x=1", {
        ...PAGE_LOAD,
        Cookie: await session(NAMED_ORIGIN),
      }),
    );
    expect(decision).toEqual({
      kind: "forward",
      surface: "preview",
      route: { machine: "demo", service: "web", path: "/v0beta1/rigs" },
      keyless: false,
      // The origin is the route. No cookie has to say which service.
      setCookies: [],
    });
  });

  it("sends a page load without a session to log in at this origin, and back", async () => {
    expect(await gateway.authorize(named("/app/page?q=1", PAGE_LOAD))).toEqual({
      kind: "login",
      location: `/__amika/login?${new URLSearchParams({ return: "/app/page?q=1" })}`,
    });
  });

  it("refuses a session another origin logged in for", async () => {
    // Each service is its own origin, and so its own login.
    const decision = await gateway.authorize(
      named("/", {
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Cookie: await session("https://api--demo.r.acme.o.amika.test"),
      }),
    );
    expect(decision).toMatchObject({ kind: "refuse", status: 401 });
  });

  it("refuses a sibling site's request that carries the session", async () => {
    // Another rig's page is the same site under the shared zone, so the
    // `Lax` session travels with its requests.
    const decision = await gateway.authorize(
      named(
        "/api/delete",
        {
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          Cookie: await session(NAMED_ORIGIN),
        },
        { method: "POST" },
      ),
    );
    expect(decision).toMatchObject({ kind: "refuse", status: 403 });
  });

  it("lets an upgrade from this origin through, and refuses one from elsewhere", async () => {
    const upgrade = async (origin: string) =>
      gateway.authorize(
        named("/live", { Origin: origin, Cookie: await session(NAMED_ORIGIN) }),
        { upgrade: true },
      );
    expect(await upgrade(NAMED_ORIGIN)).toMatchObject({ kind: "forward" });
    expect(await upgrade("https://evil--x.r.other.o.amika.test")).toMatchObject(
      { kind: "refuse", status: 403 },
    );
  });

  it("takes no host key or service token: no hop passes them to a name", async () => {
    // The reverse proxy and the gateway both drop a caller's `x-amika-`
    // headers, so these could never arrive. One that somehow did must not
    // open a door the deployed path does not have.
    const token = await signServiceToken(SECRET, {
      rig: "demo",
      service: "web",
    });
    const credentials: Record<string, string>[] = [
      { "X-Amika-Authorization": `Bearer ${token}` },
      { "X-Amika-Hostd-Key": SECRET },
    ];
    for (const credential of credentials) {
      expect(await gateway.authorize(named("/api", credential))).toMatchObject({
        kind: "refuse",
        status: 401,
      });
    }
  });

  it("refuses a frame another rig's page loads, even with a session", async () => {
    // Every rig shares the zone, so a sibling is the same site and the
    // `Lax` session rides along. A frame could be laid invisibly over the
    // sibling's own page.
    const decision = await gateway.authorize(
      named("/admin", {
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
        Cookie: await session(NAMED_ORIGIN),
      }),
    );
    expect(decision).toMatchObject({ kind: "refuse", status: 403 });
  });

  it("follows a link from another rig's page", async () => {
    const decision = await gateway.authorize(
      named("/", {
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Cookie: await session(NAMED_ORIGIN),
      }),
    );
    expect(decision).toMatchObject({ kind: "forward" });
  });

  it("never lets a browser session reach amikad at its name", async () => {
    // amikad runs commands in the rig and has no preview. Only the host
    // key reaches it.
    const amikad = (headers: Record<string, string>) =>
      gateway.authorize({
        ...request("/v1/exec", headers, {
          origin: "https://amikad--demo.r.acme.o.amika.test",
        }),
        named: { machine: "demo", service: "amikad" },
      });

    expect(
      await amikad({
        ...PAGE_LOAD,
        Cookie: await session("https://amikad--demo.r.acme.o.amika.test"),
      }),
    ).toMatchObject({ kind: "refuse", status: 404 });
    // Not sent to log in either: there is nothing to log in to.
    expect(await amikad(PAGE_LOAD)).toMatchObject({
      kind: "refuse",
      status: 404,
    });
    // Nor the host key: amikad is reached at its service route, never at
    // a name.
    expect(await amikad({ "X-Amika-Hostd-Key": SECRET })).toMatchObject({
      kind: "refuse",
      status: 404,
    });
  });

  it("lets amikad's SSH upgrade through at its name without the key", async () => {
    // A tunnel host's rig has no other address a client can dial. amikad
    // checks the connect token, as it does at the service route.
    const ssh = (
      path: string,
      headers: Record<string, string> = {},
      method = "GET",
    ) => ({
      ...request(
        path,
        { Connection: "Upgrade", Upgrade: "websocket", ...headers },
        { method, origin: "https://amikad--demo.r.acme.o.amika.test" },
      ),
      named: { machine: "demo", service: "amikad" },
    });

    // `/v2` is the resumable route, authenticated the same way.
    for (const path of ["/v1/ssh-sessions", "/v2/ssh-sessions"]) {
      expect(await gateway.authorize(ssh(path), { upgrade: true })).toEqual({
        kind: "forward",
        surface: "service",
        route: { machine: "demo", service: "amikad", path },
        keyless: true,
        setCookies: [],
      });
    }
    // Nothing else: not as a plain request, not on another path, method
    // or query, and not on another service's name.
    const refused: [GatewayRequest, boolean][] = [
      [ssh("/v1/ssh-sessions"), false],
      [ssh("/v2/ssh-sessions"), false],
      [ssh("/v3/ssh-sessions"), true],
      [ssh("/v2/ssh-sessions/"), true],
      [ssh("/v2/ssh-sessions?x=1"), true],
      [ssh("/v1/exec"), true],
      [ssh("/v1/ssh-sessions/"), true],
      [ssh("/v1/ssh%2Dsessions"), true],
      [ssh("/v1/ssh-sessions?x=1"), true],
      [ssh("/v1/ssh-sessions", {}, "POST"), true],
      [ssh("/v1/ssh-sessions", { Upgrade: "h2c" }), true],
    ];
    for (const [req, upgrade] of refused) {
      expect(await gateway.authorize(req, { upgrade })).toMatchObject({
        kind: "refuse",
        status: 404,
      });
    }
    expect(
      await gateway.authorize(
        {
          ...ssh("/v1/ssh-sessions"),
          named: { machine: "demo", service: "web" },
        },
        { upgrade: true },
      ),
    ).toMatchObject({ kind: "refuse", status: 401 });
  });

  it("leaves the login endpoints to the server", async () => {
    expect(await gateway.authorize(named("/__amika/login"))).toEqual({
      kind: "not-mine",
    });
    expect(
      await gateway.authorize(
        named("/__amika/callback", {}, { method: "POST" }),
      ),
    ).toEqual({ kind: "not-mine" });
  });

  it("refuses a browser on a server with no login", async () => {
    const noLogin = createGateway({
      secretKey: SECRET,
      isOwnPath: () => false,
    });
    expect(await noLogin.authorize(named("/", PAGE_LOAD))).toMatchObject({
      kind: "refuse",
      status: 401,
    });
  });
});

describe("hardenPreviewResponse", () => {
  // A tunnel's CDN reads these before Cache-Control.
  it("drops a guest's cache policy for CDNs", () => {
    const response = hardenPreviewResponse(
      new Response(null, {
        headers: {
          "CDN-Cache-Control": "max-age=600",
          "Cloudflare-CDN-Cache-Control": "max-age=600",
          "Surrogate-Control": "max-age=600",
        },
      }),
    );
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "x-robots-tag",
    ]);
  });
});

describe("privateCacheControl", () => {
  it.each([
    [null, "private"],
    ["", "private"],
    ["max-age=60", "private, max-age=60"],
    ["public, max-age=60", "private, max-age=60"],
    ["private, max-age=60", "private, max-age=60"],
    ["no-store", "no-store"],
  ])("makes %j %j", (value, expected) => {
    expect(privateCacheControl(value)).toBe(expected);
  });
});

/** The return path `startLogin` keeps in the state cookie for `back`. */
function storedReturn(back: string): string {
  const response = startLogin(
    new Request(
      `${ORIGIN}/__amika/login?${new URLSearchParams({ return: back })}`,
    ),
    AMIKA,
  );
  const value = response.headers.getSetCookie()[0].split(";")[0].split("=")[1];
  return Buffer.from(value.split(".")[1], "base64url").toString("utf8");
}

describe("startLogin", () => {
  it("keeps the path and query to return to", () => {
    expect(storedReturn("/docs?tab=2")).toBe("/docs?tab=2");
  });

  // Checked where it is stored, not only where it is read back.
  it.each([
    "//evil.example/x",
    "/\t/evil.example",
    "/\\evil.example",
    // Dot segments collapse only once resolved, into `//evil.example`.
    "/..//evil.example/x",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/a/..//evil.example",
    "/__amika/callback",
  ])("stores / for %j", (back) => {
    expect(storedReturn(back)).toBe("/");
  });

  // A browser drops a cookie over 4 KB, which would fail the login.
  it("stores / for a path too long once encoded", () => {
    expect(storedReturn(`/${'"'.repeat(1500)}`)).toBe("/");
    expect(storedReturn(`/${"a".repeat(1500)}`)).toBe(`/${"a".repeat(1500)}`);
  });
});

describe("usedLoginStates", () => {
  it("answers a state once, until its passes have expired", () => {
    const used = usedLoginStates(1000);
    expect(used.claim("s", 0)).toBe(true);
    expect(used.claim("s", 999)).toBe(false);
    expect(used.claim("s", 1000)).toBe(true);
  });
});

describe("browserOrigin", () => {
  it.each([
    ["https://preview.example/x", ORIGIN],
    ["http://preview.example/x", ORIGIN],
    ["https://preview.example:8443/x", null],
    ["http://localhost/x", null],
    ["http://127.0.0.1/x", null],
  ])("makes %s %j", (url, origin) => {
    expect(browserOrigin(new URL(url))).toBe(origin);
  });
});

describe("the login endpoints", () => {
  const get = (path: string): GatewayRequest => ({
    method: "GET",
    url: new URL(`${ORIGIN}${path}`),
    headers: new Headers(),
  });
  const isOwnPath = () => false;

  it("are the gateway's only with Amika's URL", () => {
    const gateway = createGateway({
      secretKey: "k",
      isOwnPath,
      amikaUrl: AMIKA,
    });
    expect(gateway.claims(get("/__amika/login"))).toBe(true);
    expect(gateway.claims(get("/__amika/callback"))).toBe(true);
    const plain = createGateway({ secretKey: "k", isOwnPath });
    expect(plain.claims(get("/__amika/login"))).toBe(false);
    expect(plain.claims(get("/__amika/callback"))).toBe(false);
  });
});
