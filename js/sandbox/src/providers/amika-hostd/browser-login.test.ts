/** Cover login passes, sessions, preview paths and which origins can log in. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LOGIN_PASS_TTL_S,
  SESSION_TTL_S,
  isBrowserLoginOrigin,
  previewPath,
  signLoginPass,
  signSession,
  verifyLoginPass,
  verifySession,
} from "./browser-login";
import { signServiceLink } from "./service-links";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_791_417_600;
const ORIGIN = "https://preview.example";
const STATE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PASS = { origin: ORIGIN, state: STATE, user: "user_1" };

describe("login passes", () => {
  const verify = (
    token: string,
    { origin = ORIGIN, state = STATE, now = NOW, secret = SECRET } = {},
  ) => verifyLoginPass(secret, token, { origin, state }, now);

  it("signs the payload under the documented derived key", async () => {
    // Independent of the module: Amika and hostd must agree on this.
    const key = createHmac("sha256", SECRET)
      .update("amika-hostd login passes v1")
      .digest();
    const token = await signLoginPass(SECRET, PASS, NOW);
    const [payload, signature] = token.split(".");
    expect(
      JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
    ).toEqual({ o: ORIGIN, s: STATE, u: "user_1", e: NOW + LOGIN_PASS_TTL_S });
    expect(signature).toBe(
      createHmac("sha256", key).update(payload!).digest("base64url"),
    );
  });

  it("vouches for its user until it expires", async () => {
    const token = await signLoginPass(SECRET, PASS, NOW);
    expect(await verify(token)).toEqual({ user: "user_1" });
    expect(await verify(token, { now: NOW + LOGIN_PASS_TTL_S - 1 })).toEqual({
      user: "user_1",
    });
    expect(await verify(token, { now: NOW + LOGIN_PASS_TTL_S })).toBe(
      "expired",
    );
  });

  it.each([
    ["another origin", { origin: "https://other.example" }],
    ["another login's state", { state: `B${STATE.slice(1)}` }],
    ["another host's secret key", { secret: `${SECRET}x` }],
  ])("refuses a pass for %s", async (_label, options) => {
    const token = await signLoginPass(SECRET, PASS, NOW);
    expect(await verify(token, options)).toBe("invalid");
  });

  it("refuses a pass that claims to outlive any pass", async () => {
    // As only a buggy or forged issuer could mint one.
    const token = await signLoginPass(SECRET, PASS, NOW + 3600);
    expect(await verify(token)).toBe("invalid");
  });

  it("refuses an edited payload", async () => {
    const token = await signLoginPass(SECRET, PASS, NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ o: ORIGIN, s: STATE, u: "admin", e: NOW + 60 }),
    ).toString("base64url");
    expect(await verify(`${forged}.${signature}`)).toBe("invalid");
  });

  // Each credential has its own derived key, so none stands in for another.
  it("refuses a session or a service link as a pass", async () => {
    const session = await signSession(SECRET, PASS, NOW);
    expect(await verify(session)).toBe("invalid");
    const link = await signServiceLink(SECRET, {
      rig: "demo",
      service: "web",
      expiresAt: NOW + 60,
    });
    expect(await verify(link)).toBe("invalid");
  });

  it.each(["", ".", "abc", "abc.def", `${"a".repeat(3000)}.x`, "a b.c"])(
    "treats %j as malformed",
    async (token) => {
      expect(await verify(token)).toBe("malformed");
    },
  );

  it("refuses to sign for a malformed state", async () => {
    await expect(
      signLoginPass(SECRET, { ...PASS, state: "short" }, NOW),
    ).rejects.toThrow("state");
  });
});

describe("sessions", () => {
  const verify = (token: string, { origin = ORIGIN, now = NOW } = {}) =>
    verifySession(SECRET, token, { origin }, now);

  it("vouches for its user at its origin for a day", async () => {
    const token = await signSession(SECRET, PASS, NOW);
    expect(await verify(token)).toEqual({
      user: "user_1",
      expiresAt: NOW + SESSION_TTL_S,
    });
    expect(await verify(token, { now: NOW + SESSION_TTL_S })).toBe("expired");
    expect(await verify(token, { origin: "https://other.example" })).toBe(
      "invalid",
    );
  });

  it("refuses a login pass as a session", async () => {
    const pass = await signLoginPass(SECRET, PASS, NOW);
    expect(await verify(pass)).toBe("invalid");
  });
});

describe("previewPath", () => {
  it("encodes the service as one segment and ends in a slash", () => {
    expect(previewPath("/v0beta1/rigs", "demo", "Coding Agent/v2")).toBe(
      "/v0beta1/rigs/demo/previews/Coding%20Agent%2Fv2/",
    );
  });
});

describe("isBrowserLoginOrigin", () => {
  it.each([
    "https://preview.example",
    "https://preview.example/",
    "https://abc.ngrok.app",
    "https://203.0.113.7",
    "https://[2001:db8::1]",
  ])("accepts %s", (url) => {
    expect(isBrowserLoginOrigin(url)).toBe(true);
  });

  it.each([
    ["plain http", "http://preview.example"],
    ["an explicit port", "https://preview.example:8443"],
    ["a path", "https://example.com/hostd/"],
    ["localhost", "https://localhost"],
    ["a localhost subdomain", "https://a.localhost"],
    ["a loopback address", "https://127.0.0.1"],
    ["an odd loopback spelling", "https://0x7f.1"],
    ["the unspecified address", "https://0.0.0.0"],
    ["IPv6 loopback", "https://[::1]"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]"],
    ["not a URL", "preview.example"],
  ])("refuses %s", (_label, url) => {
    expect(isBrowserLoginOrigin(url)).toBe(false);
  });
});
