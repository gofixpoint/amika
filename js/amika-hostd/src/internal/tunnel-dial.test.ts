/**
 * The handshake, and what the gateway's answer means for the next attempt.
 *
 * `tunnel-attachment.test.ts` dials a real WebSocket server; this file
 * covers the decisions around that dial, which are the ones that decide
 * whether a revoked host retries for ever or tells its operator.
 */
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import {
  dialTunnel,
  type ConnectOptions,
  refusal,
  requireSecureGateway,
  TunnelRejected,
  TunnelUnavailable,
  TUNNEL_SUBPROTOCOL,
} from "./tunnel-dial.js";

describe("the handshake the gateway reads", () => {
  // The gateway refuses a dial that does not use its own spelling, so these
  // names are the contract with amika-mono's `host-listener.ts`, restated
  // here rather than imported from the module under test.
  it("names the host and carries the credential in the gateway's headers", () => {
    let sent: ConnectOptions | undefined;
    void dialTunnel(
      {
        gatewayUrl: "wss://gateway.amika.test/v1/host-tunnel",
        hostId: "host-1",
        credential: "cred-1",
        generation: 1,
      },
      {
        handshakeTimeoutMs: 1_000,
        userAgent: "amika-hostd/test",
        connect: (_url, options) => {
          sent = options;
          // Never opens: only what the dial would send is under test.
          return new EventEmitter() as unknown as WebSocket;
        },
      },
    );
    const headers = sent?.headers as Record<string, string>;
    expect(headers["x-amika-host-id"]).toBe("host-1");
    expect(headers["x-amika-host-credential"]).toBe("cred-1");
    // Not a bearer token: the gateway passes the value on unread.
    expect(headers.authorization).toBeUndefined();
  });
});

describe("what a gateway's status means", () => {
  it.each([401, 403, 404, 410, 426])(
    "%d is final, so the loop stops and the operator is told",
    (status) => {
      const answer = refusal(status);

      expect(answer).toBeInstanceOf(TunnelRejected);
      expect(answer.message).toMatch(/amika-hostd|Upgrade amika-hostd|revoked/);
    },
  );

  it.each([429, 500, 502, 503, 504, 0])(
    "%d is an outage, so the daemon waits and dials again",
    (status) => {
      // The split matters in both directions: a refusal retried for ever
      // is a host nobody notices is dead, and an outage treated as a
      // refusal takes a working host offline because the control plane
      // hiccuped once. The gateway makes the same split internally.
      expect(refusal(status)).toBeInstanceOf(TunnelUnavailable);
    },
  );

  it("names the protocol version in the upgrade message", () => {
    expect(refusal(426).message).toContain(TUNNEL_SUBPROTOCOL);
  });
});

describe("the gateway address", () => {
  it("accepts wss", () => {
    expect(requireSecureGateway("wss://tunnel.amika.dev/attach")).toBe(
      "wss://tunnel.amika.dev/attach",
    );
  });

  it.each([
    "ws://localhost:8787/attach",
    "ws://127.0.0.1:8787/attach",
    "ws://[::1]:8787/",
  ])(
    "accepts plain ws on loopback, for a gateway on this machine: %s",
    (url) => {
      expect(() => requireSecureGateway(url)).not.toThrow();
    },
  );

  it("refuses plain ws anywhere else", () => {
    // The credential authorizes receiving this host's traffic, and it
    // would be on the wire in clear.
    expect(() => requireSecureGateway("ws://tunnel.amika.dev/attach")).toThrow(
      /must be wss/,
    );
  });

  it("refuses a scheme that is not a WebSocket at all", () => {
    expect(() => requireSecureGateway("https://tunnel.amika.dev")).toThrow(
      TunnelRejected,
    );
    expect(() => requireSecureGateway("file:///etc/passwd")).toThrow(
      TunnelRejected,
    );
  });

  it("refuses a hostname that merely starts like loopback", () => {
    expect(() =>
      requireSecureGateway("ws://localhost.evil.example/attach"),
    ).toThrow(/must be wss/);
    expect(() => requireSecureGateway("ws://127.0.0.1.evil.example/")).toThrow(
      /must be wss/,
    );
  });

  it("refuses something that is not a URL", () => {
    expect(() => requireSecureGateway("tunnel.amika.dev")).toThrow(/not a URL/);
  });
});
