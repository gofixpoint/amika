/** Exercise browser login and previews through the daemon's HTTP boundary. */
import { signLoginPass } from "@amika/sandbox/hostd-browser-login";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { privateCacheControl } from "./internal/browser-login.js";
import type { MachineRuntime } from "./internal/machine-runtime.js";
import { memoryServiceRegistry } from "./internal/service-registry.js";

const SECRET = "test-secret";
const AMIKA = "https://app.amika.test";
const HOST = "https://preview.example";
const PREVIEW = `${HOST}/v0beta1/rigs/demo/previews/web`;
const NAVIGATE = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };

/** A host whose `demo` rig serves `web` and amikad; the guest answers `ok`. */
function host({ amikaUrl = AMIKA as string | null } = {}) {
  const runtime = {
    hostPort: vi.fn(async () => 41001),
  } as unknown as MachineRuntime;
  const registry = memoryServiceRegistry();
  registry.set("demo", { amikad: 60999, web: 3000 });
  const guest = vi.fn<typeof fetch>(
    async () =>
      new Response("ok", {
        headers: { "Cache-Control": "public, max-age=60" },
      }),
  );
  const app = createApp(
    { secretKey: SECRET, amikaUrl: amikaUrl ?? undefined },
    runtime,
    {
      registry,
      fetch: guest,
    },
  );
  return { app, guest };
}

/** The `name=value` of the cookie `name` among a response's `Set-Cookie`s. */
function setCookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
}

/** Log in as a browser would: login, Amika's pass, callback. */
async function logIn(
  app: ReturnType<typeof createApp>,
  back = "/v0beta1/rigs/demo/previews/web/",
) {
  const start = await app.request(
    `${HOST}/__amika/login?${new URLSearchParams({ return: back })}`,
  );
  const stateCookie = setCookie(start, "__Host-amika-login")!.split(";")[0];
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const pass = await signLoginPass(SECRET, {
    origin: HOST,
    state,
    user: "user_1",
  });
  const callback = await app.request(`${HOST}/__amika/callback`, {
    method: "POST",
    headers: { Cookie: stateCookie },
    body: new URLSearchParams({ pass }),
  });
  const session = setCookie(callback, "__Host-amika-session")?.split(";")[0];
  return { start, callback, session, stateCookie, pass };
}

describe("browser login", () => {
  it("lists browser-login in health only with Amika's URL to log in at", async () => {
    const health = async (amikaUrl: string | null) => {
      const response = await host({ amikaUrl }).app.request("/health", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      return ((await response.json()) as { features: string[] }).features;
    };
    expect(await health(AMIKA)).toContain("browser-login");
    expect(await health(null)).not.toContain("browser-login");
  });

  it("sends a page load without a session to log in, and back", async () => {
    const { app, guest } = host();
    const response = await app.request(`${PREVIEW}/docs?x=1`, {
      headers: NAVIGATE,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/__amika/login?return=${encodeURIComponent("/v0beta1/rigs/demo/previews/web/docs?x=1")}`,
    );
    expect(guest).not.toHaveBeenCalled();
  });

  it("refuses anything but a page load without a session", async () => {
    const { app, guest } = host();
    const response = await app.request(`${PREVIEW}/api/data`);
    expect(response.status).toBe(401);
    expect(guest).not.toHaveBeenCalled();
  });

  it("starts a login at Amika, naming this host's origin", async () => {
    const { start } = await logIn(host().app);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      `${AMIKA}/hosts/authorize`,
    );
    expect(location.searchParams.get("origin")).toBe(HOST);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The state has to come back on Amika's cross-site form post.
    expect(setCookie(start, "__Host-amika-login")).toMatch(
      /; Max-Age=600; HttpOnly; Secure; SameSite=None$/,
    );
    expect(start.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["a loopback address", "http://localhost:3020"],
    ["an explicit port", "https://preview.example:8443"],
  ])("refuses to start a login on %s", async (_label, origin) => {
    const response = await host().app.request(`${origin}/__amika/login`);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("sets a session on a valid pass and returns to the preview", async () => {
    const { callback, session } = await logIn(host().app);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(
      "/v0beta1/rigs/demo/previews/web/",
    );
    // Lax: a preview opened from Amika, another site, still carries it.
    expect(setCookie(callback, "__Host-amika-session")).toMatch(
      /; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(setCookie(callback, "__Host-amika-login")).toMatch(/Max-Age=0/);
    expect(session).toBeDefined();
  });

  it("serves the preview with a session, keeping hostd's cookies off the guest", async () => {
    const { app, guest } = host();
    const { session } = await logIn(app);
    const response = await app.request(`${PREVIEW}/docs?x=1`, {
      headers: { ...NAVIGATE, Cookie: `${session}; theme=dark` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    const [[target, init]] = guest.mock.calls;
    expect(target).toBe("http://127.0.0.1:41001/docs?x=1");
    expect(new Headers(init?.headers).get("cookie")).toBe("theme=dark");
    // No credential in the URL, so the guest's caching stands, but private.
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    // And its root-relative URLs now reach this service.
    expect(setCookie(response, "__Host-amika-preview")).toMatch(
      /^__Host-amika-preview=demo\/web; .*SameSite=Strict$/,
    );
  });

  it("routes a root-relative URL to the preview the page opened", async () => {
    const { app, guest } = host();
    const { session } = await logIn(app);
    const cookie = `${session}; __Host-amika-preview=demo/web`;
    const response = await app.request(`${HOST}/@vite/client`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(200);
    expect(guest.mock.calls[0][0]).toBe("http://127.0.0.1:41001/@vite/client");

    // Not without the session, and not for another site's page.
    const withoutSession = await app.request(`${HOST}/@vite/client`, {
      headers: {
        Cookie: "__Host-amika-preview=demo/web",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(withoutSession.status).toBe(401);
    const crossSite = await app.request(`${HOST}/@vite/client`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-site" },
    });
    expect(crossSite.status).toBe(401);
  });

  it("answers a pass once", async () => {
    const { app } = host();
    const { stateCookie, pass } = await logIn(app);
    const replay = await app.request(`${HOST}/__amika/callback`, {
      method: "POST",
      headers: { Cookie: stateCookie },
      body: new URLSearchParams({ pass }),
    });
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a pass for another browser's login", async () => {
    const { app } = host();
    const { pass } = await logIn(app);
    // A login this browser started, but not the one the pass answers.
    const other = await app.request(`${HOST}/__amika/login`);
    const response = await app.request(`${HOST}/__amika/callback`, {
      method: "POST",
      headers: {
        Cookie: setCookie(other, "__Host-amika-login")!.split(";")[0],
      },
      body: new URLSearchParams({ pass }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a pass with no login state at all", async () => {
    const { app } = host();
    const { pass } = await logIn(app);
    const response = await app.request(`${HOST}/__amika/callback`, {
      method: "POST",
      body: new URLSearchParams({ pass }),
    });
    expect(response.status).toBe(401);
  });

  it("never returns to another origin after login", async () => {
    const { callback } = await logIn(host().app, "//evil.example/x");
    expect(callback.headers.get("location")).toBe("/");
  });

  it("refuses a session at another origin", async () => {
    const { app } = host();
    const { session } = await logIn(app);
    const response = await app.request(
      "https://other.example/v0beta1/rigs/demo/previews/web/",
      { headers: { Cookie: session! } },
    );
    expect(response.status).toBe(401);
  });

  it("serves no preview of amikad, session or not", async () => {
    const { app, guest } = host();
    const { session } = await logIn(app);
    const response = await app.request(
      `${HOST}/v0beta1/rigs/demo/previews/amikad/`,
      { headers: { ...NAVIGATE, Cookie: session! } },
    );
    expect(response.status).toBe(401);
    expect(guest).not.toHaveBeenCalled();
  });

  it("does not let a session open the keyed service route", async () => {
    const { app } = host();
    const { session } = await logIn(app);
    const response = await app.request(
      `${HOST}/v0beta1/rigs/demo/services/web/`,
      { headers: { Cookie: session! } },
    );
    expect(response.status).toBe(401);
  });

  it("serves no previews or login without Amika's URL", async () => {
    const { app } = host({ amikaUrl: null });
    expect((await app.request(`${HOST}/__amika/login`)).status).toBe(401);
    expect(
      (await app.request(`${PREVIEW}/`, { headers: NAVIGATE })).status,
    ).toBe(401);
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
