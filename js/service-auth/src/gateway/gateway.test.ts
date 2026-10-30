/** Cover the gateway's decision for each way in, without a server. */
import { describe, expect, it } from "vitest";
import { signServiceToken, signSession } from "../credentials";
import { SESSION_COOKIE } from "./cookies";
import { createGateway } from "./gateway";
import {
  SERVICE_AUTH_MODES,
  type GatewayRequest,
  type NamedService,
} from "./routes";

const SECRET = "0123456789abcdef0123456789abcdef";
const gateway = createGateway({
  secretKey: SECRET,
  isOwnPath: (pathname) => pathname.startsWith("/v0beta1/"),
});

function request(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): GatewayRequest {
  return {
    method,
    url: new URL(`https://preview.example${path}`),
    headers: new Headers(headers),
  };
}

describe("createGateway", () => {
  it("forwards a keyed service request to its guest path", async () => {
    const decision = await gateway.authorize(
      request("/v0beta1/rigs/demo/services/web/api", {
        "X-Amika-Hostd-Key": SECRET,
      }),
    );
    expect(decision).toEqual({
      kind: "forward",
      surface: "service",
      route: { machine: "demo", service: "web", path: "/api" },
      keyless: false,
      setCookies: [],
    });
  });

  it("forwards a service token for its service, and hints when refused", async () => {
    const token = await signServiceToken(SECRET, {
      rig: "demo",
      service: "web",
    });
    const ok = await gateway.authorize(
      request("/v0beta1/rigs/demo/services/web/", {
        "X-Amika-Authorization": `Bearer ${token}`,
      }),
    );
    expect(ok.kind).toBe("forward");

    const refused = await gateway.authorize(
      request("/v0beta1/rigs/demo/services/web/"),
    );
    expect(refused).toMatchObject({
      kind: "refuse",
      surface: "service",
      status: 401,
      hint: expect.stringContaining("X-Amika-Authorization"),
    });
  });

  // Service links are retired: their path and their cookie are no longer
  // the gateway's, so the server asks for its key and nothing is forwarded.
  it("claims neither a retired service link nor its cookie", async () => {
    const link = request(
      "/v0beta1/rigs/demo/service-links/web/1791417600.sig/",
      { "Sec-Fetch-Mode": "navigate" },
    );
    expect(gateway.claims(link)).toBe(false);
    expect(await gateway.authorize(link)).toEqual({ kind: "not-mine" });

    const asset = request("/@vite/client", {
      Cookie: "__Host-amika-service-link=demo/web/1791417600.sig",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(gateway.claims(asset)).toBe(false);
    expect(await gateway.authorize(asset)).toEqual({ kind: "not-mine" });
  });

  it("leaves anything else to the server", async () => {
    expect(await gateway.authorize(request("/health"))).toEqual({
      kind: "not-mine",
    });
    expect(gateway.claims(request("/health"))).toBe(false);
    expect(gateway.claims(request("/v0beta1/rigs/demo/services/web/"))).toBe(
      true,
    );
  });

  // Only an upgrade may be amikad's SSH WebSocket, never a plain request.
  it("lets amikad's SSH upgrade through without the key only as an upgrade", async () => {
    const ssh = request("/v0beta1/rigs/demo/services/amikad/v1/ssh-sessions", {
      Connection: "Upgrade",
      Upgrade: "websocket",
    });
    expect(await gateway.authorize(ssh, { upgrade: true })).toMatchObject({
      kind: "forward",
      keyless: true,
    });
    expect(await gateway.authorize(ssh)).toMatchObject({
      kind: "refuse",
      status: 401,
    });
  });

  it("keeps its credentials from the guest", () => {
    expect(gateway.isCredentialHeader("x-amika-hostd-key")).toBe(true);
    expect(gateway.isCredentialHeader("x-amika-authorization")).toBe(true);
    expect(gateway.isCredentialHeader("authorization")).toBe(false);
    expect(
      gateway.guestCookies("theme=dark; __Host-amika-service-link=a/b/c"),
    ).toBe("theme=dark");
  });

  it("keeps a guest from setting the gateway's cookies", async () => {
    const decision = await gateway.authorize(
      request("/v0beta1/rigs/demo/services/web/", {
        "X-Amika-Hostd-Key": SECRET,
      }),
    );
    if (decision.kind !== "forward") throw new Error(decision.kind);
    const headers = new Headers();
    headers.append("set-cookie", "theme=dark; Path=/");
    headers.append("set-cookie", "__Host-amika-session=forged; Path=/");
    headers.append("set-cookie", "__HOST-AMIKA-login=fixed; Path=/");
    const response = gateway.finish(decision, new Response(null, { headers }));
    expect(response.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
  });

  it("keeps a guest's upgrade answer from setting the gateway's cookies", () => {
    expect(
      gateway.finishUpgrade(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Set-Cookie: theme=dark; Path=/",
          "set-cookie:__Host-amika-session=forged; Path=/",
          "SET-COOKIE: __HOST-AMIKA-login=fixed",
          // Folded: the name only appears once the line is unfolded.
          "Set-Cookie:",
          " __Host-amika-service-link=x; Path=/",
          "Connection: Upgrade",
        ].join("\r\n"),
      ),
    ).toBe(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Set-Cookie: theme=dark; Path=/",
        "Connection: Upgrade",
      ].join("\r\n"),
    );
  });

  it("hardens every answer on a preview, and only there", async () => {
    const preview = gateway.refusal({
      kind: "refuse",
      surface: "preview",
      status: 401,
    });
    expect(preview.headers.get("cache-control")).toMatch(/^private/);
    expect(preview.headers.get("x-robots-tag")).toBe("noindex");
    const service = gateway.refusal({
      kind: "refuse",
      surface: "service",
      status: 401,
      hint: "send a token",
    });
    expect(service.headers.get("cache-control")).toBeNull();
    expect(await service.json()).toEqual({
      error: "Unauthorized",
      hint: "send a token",
    });
  });
});

/**
 * A service at its own name, with each access mode. The server (hostd) says
 * who may have the name; this covers what the gateway then asks of the
 * caller. The browser login end to end is hostd's `hostname-login.test.ts`.
 */
describe("a named service", () => {
  const NAME = "web--demo.r.acme.o.amika.test";
  const ORIGIN = `https://${NAME}`;
  const previews = createGateway({
    secretKey: SECRET,
    isOwnPath: (pathname) => pathname.startsWith("/v0beta1/"),
    amikaUrl: "https://app.amika.test",
  });
  const session = async (user: string) =>
    `${SESSION_COOKIE}=${await signSession(SECRET, { origin: ORIGIN, user })}`;
  const named = (
    headers: Record<string, string>,
    service: Partial<NamedService> = {},
    method = "GET",
  ): GatewayRequest => ({
    method,
    url: new URL(`${ORIGIN}/app?q=1`),
    headers: new Headers(headers),
    named: { machine: "demo", service: "web", ...service },
  });
  const forwarded = (surface: "service" | "preview") => ({
    kind: "forward",
    surface,
    route: { machine: "demo", service: "web", path: "/app" },
    keyless: false,
    setCookies: [],
  });

  it("admits any member's session by default, and sends a page to log in", async () => {
    const page = named({ "sec-fetch-mode": "navigate" });
    expect(await previews.authorize(page)).toEqual({
      kind: "login",
      location: "/__amika/login?return=%2Fapp%3Fq%3D1",
    });
    const member = named({
      "sec-fetch-mode": "navigate",
      cookie: await session("user_2"),
    });
    expect(await previews.authorize(member)).toEqual(forwarded("preview"));
  });

  it("admits the owner alone with owner, and nobody without one", async () => {
    const owner = { auth: "owner" as const, owner: "user_1" };
    const mine = named(
      { "sec-fetch-site": "same-origin", cookie: await session("user_1") },
      owner,
    );
    expect(await previews.authorize(mine)).toEqual(forwarded("preview"));

    const theirs = named(
      { "sec-fetch-site": "same-origin", cookie: await session("user_2") },
      owner,
    );
    expect(await previews.authorize(theirs)).toMatchObject({
      kind: "refuse",
      status: 403,
      reason: expect.stringContaining("another user"),
    });
    expect(
      await previews
        .refusal((await previews.authorize(theirs)) as never)
        .json(),
    ).toEqual({
      error: "Forbidden: this rig belongs to another user",
    });

    // No session still logs in first, as for any member.
    const page = named({ "sec-fetch-mode": "navigate" }, owner);
    expect((await previews.authorize(page)).kind).toBe("login");

    // A server that never said who owns the rig admits nobody as its owner.
    const unowned = named(
      { "sec-fetch-site": "same-origin", cookie: await session("user_1") },
      { auth: "owner" },
    );
    expect((await previews.authorize(unowned)).kind).toBe("refuse");
  });

  it("forwards everything to a public service, as a service", async () => {
    const pub = { auth: "public" as const };
    // No session, from another origin, a preflight, an upgrade: all the
    // service's to answer, Authorization included.
    for (const [headers, method, upgrade] of [
      [{}, "GET", false],
      [
        {
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "empty",
          origin: "https://app.t3.codes",
        },
        "OPTIONS",
        false,
      ],
      [
        { authorization: "Bearer app-token", "sec-fetch-site": "cross-site" },
        "POST",
        false,
      ],
      [{ connection: "Upgrade", upgrade: "websocket" }, "GET", true],
    ] as const) {
      const decision = await previews.authorize(named(headers, pub, method), {
        upgrade,
      });
      expect(decision).toEqual(forwarded("service"));
    }
    // Without previews on the host, too: nothing to log in to is needed.
    expect(await gateway.authorize(named({}, pub))).toEqual(
      forwarded("service"),
    );
  });

  it("keeps amikad's own rules whatever the mode says", async () => {
    for (const auth of SERVICE_AUTH_MODES) {
      const decision = await previews.authorize(
        named(
          { cookie: await session("user_1"), "sec-fetch-site": "same-origin" },
          { service: "amikad", auth },
        ),
      );
      expect(decision).toEqual({
        kind: "refuse",
        surface: "service",
        status: 404,
      });
    }
  });
});
