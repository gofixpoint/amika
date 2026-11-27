import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { namedRoute, routeRigService } from "./tunnel-rig-route.js";

/** A request as Node presents one, with both views of its headers. */
function incoming(
  url: string,
  lines: Array<[string, string]>,
): IncomingMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of lines) headers[name.toLowerCase()] = value;
  return {
    url,
    headers,
    rawHeaders: lines.flat(),
  } as unknown as IncomingMessage;
}

describe("routeRigService", () => {
  it("names the request for its rig and service, and keeps its path", () => {
    const request = incoming("/a/b?q=1", [
      ["Host", "s-web--hacks--acme.amika.run"],
      ["X-Amika-Rig", "hacks"],
      ["x-amika-service", "web"],
    ]);

    expect(routeRigService(request)).toEqual({
      kind: "named",
      route: { machine: "hacks", service: "web" },
    });
    expect(namedRoute(request)).toEqual({ machine: "hacks", service: "web" });
    // The path is the service's own: the origin says which service.
    expect(request.url).toBe("/a/b?q=1");
  });

  it("removes both headers from both views of the request", () => {
    const request = incoming("/", [
      ["Host", "s-web--hacks--acme.amika.run"],
      ["X-Amika-Rig", "hacks"],
      ["x-amika-service", "web"],
      ["Accept", "text/html"],
    ]);

    routeRigService(request);

    expect(request.headers).toEqual({
      host: "s-web--hacks--acme.amika.run",
      accept: "text/html",
    });
    expect(request.rawHeaders).toEqual([
      "Host",
      "s-web--hacks--acme.amika.run",
      "Accept",
      "text/html",
    ]);
  });

  it("leaves a request that names no rig for the API", () => {
    const request = incoming("/v0beta1/rigs", [["Host", "container"]]);

    expect(routeRigService(request)).toEqual({ kind: "api" });
    expect(namedRoute(request)).toBeUndefined();
  });

  it.each([
    ["only a rig", "/", [["x-amika-rig", "hacks"]]],
    ["only a service", "/", [["x-amika-service", "web"]]],
    [
      "a rig with a slash",
      "/",
      [
        ["x-amika-rig", "a/b"],
        ["x-amika-service", "web"],
      ],
    ],
    [
      "a service with a dot",
      "/",
      [
        ["x-amika-rig", "a"],
        ["x-amika-service", ".."],
      ],
    ],
    [
      "an empty rig",
      "/",
      [
        ["x-amika-rig", ""],
        ["x-amika-service", "web"],
      ],
    ],
    [
      "an absolute target",
      "http://evil.example/",
      [
        ["x-amika-rig", "a"],
        ["x-amika-service", "web"],
      ],
    ],
    [
      "a protocol-relative target",
      "//evil.example/",
      [
        ["x-amika-rig", "a"],
        ["x-amika-service", "web"],
      ],
    ],
  ] as Array<[string, string, Array<[string, string]>]>)(
    "refuses %s, and names nothing",
    (_case, url, lines) => {
      const request = incoming(url, lines);

      expect(routeRigService(request)).toMatchObject({ kind: "refuse" });
      expect(namedRoute(request)).toBeUndefined();
    },
  );
});

describe("namedRoute", () => {
  it("names nothing for a request the tunnel never read", () => {
    // A listener's request carrying the same headers: nothing reads them.
    const request = incoming("/", [
      ["x-amika-rig", "hacks"],
      ["x-amika-service", "web"],
    ]);
    expect(namedRoute(request)).toBeUndefined();
    expect(namedRoute(undefined)).toBeUndefined();
  });
});
