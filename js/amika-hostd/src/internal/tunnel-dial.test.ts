/**
 * The handshake, and what the gateway's answer means for the next attempt.
 *
 * `tunnel-session.test.ts` dials a real WebSocket server; this file
 * covers the decisions around that dial, which are the ones that decide
 * whether a revoked host retries for ever or tells its operator.
 */
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as WebSocketClient, type WebSocket } from "ws";
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
        gatewayUrl: "wss://gateway.amika.test/v2/host-tunnel",
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
    expect(headers["x-amika-host-token"]).toBe("cred-1");
    expect(headers["x-amika-host-credential"]).toBeUndefined();
    // Not a bearer token: the gateway passes the value on unread.
    expect(headers.authorization).toBeUndefined();
  });
});

describe("the v3 offer and the resume handshake", () => {
  const target = {
    gatewayUrl: "wss://gateway.amika.test/v2/host-tunnel",
    hostId: "host-1",
    credential: "cred-1",
    generation: 1,
  };

  /** A socket that opens with `protocol` and a `101` carrying `headers`. */
  function opening(protocol: string, headers: Record<string, string> = {}) {
    let sent: ConnectOptions | undefined;
    const socket = Object.assign(new EventEmitter(), {
      protocol,
      close: () => {},
      paused: false,
      pause() {
        this.paused = true;
      },
    });
    const connect = (_url: string, options: ConnectOptions) => {
      sent = options;
      setImmediate(() => {
        socket.emit("upgrade", { headers });
        socket.emit("open");
      });
      return socket as unknown as WebSocket;
    };
    return { connect, sent: () => sent };
  }

  it("offers v2 alone by default, and sends no resume headers", async () => {
    const socket = opening(TUNNEL_SUBPROTOCOL);
    const dialed = await dialTunnel(target, {
      handshakeTimeoutMs: 1_000,
      userAgent: "amika-hostd/test",
      connect: socket.connect,
    });
    expect(socket.sent()?.protocols).toEqual([TUNNEL_SUBPROTOCOL]);
    const headers = socket.sent()?.headers as Record<string, string>;
    expect(headers["x-amika-tunnel-session"]).toBeUndefined();
    expect(headers["x-amika-tunnel-received"]).toBeUndefined();
    expect(dialed.protocol).toBe(TUNNEL_SUBPROTOCOL);
    // Paused until a link takes it, so no frame is emitted unheard.
    expect((dialed.ws as unknown as { paused: boolean }).paused).toBe(true);
  });

  it("offers v3 first, names the session to resume, and reads the answer", async () => {
    const socket = opening("amika.tunnel.v3", {
      "x-amika-connection-id": "conn-1",
      "x-amika-tunnel-received": "42",
    });
    const dialed = await dialTunnel(target, {
      handshakeTimeoutMs: 1_000,
      userAgent: "amika-hostd/test",
      protocols: ["amika.tunnel.v3", TUNNEL_SUBPROTOCOL],
      resume: { connectionId: "conn-1", received: 17 },
      connect: socket.connect,
    });
    expect(socket.sent()?.protocols).toEqual([
      "amika.tunnel.v3",
      TUNNEL_SUBPROTOCOL,
    ]);
    const headers = socket.sent()?.headers as Record<string, string>;
    expect(headers["x-amika-tunnel-session"]).toBe("conn-1");
    expect(headers["x-amika-tunnel-received"]).toBe("17");
    expect(dialed).toMatchObject({
      protocol: "amika.tunnel.v3",
      connectionId: "conn-1",
      received: "42",
    });
  });

  it("accepts v2 from a relay that does not speak v3", async () => {
    const socket = opening(TUNNEL_SUBPROTOCOL, {
      "x-amika-connection-id": "conn-9",
    });
    const dialed = await dialTunnel(target, {
      handshakeTimeoutMs: 1_000,
      userAgent: "amika-hostd/test",
      protocols: ["amika.tunnel.v3", TUNNEL_SUBPROTOCOL],
      resume: { connectionId: "conn-1", received: 17 },
      connect: socket.connect,
    });
    expect(dialed.protocol).toBe(TUNNEL_SUBPROTOCOL);
    expect(dialed.received).toBeUndefined();
  });

  it("refuses a subprotocol it did not offer", async () => {
    const socket = opening("amika.tunnel.v3");
    await expect(
      dialTunnel(target, {
        handshakeTimeoutMs: 1_000,
        userAgent: "amika-hostd/test",
        connect: socket.connect,
      }),
    ).rejects.toBeInstanceOf(TunnelUnavailable);
  });
});

describe("a gateway that refuses the upgrade", () => {
  it("rejects the dial and the socket closes without an unhandled error", async () => {
    // The gateway answers the upgrade with a plain 503, as it does when
    // the relay is not ready after a tunnel close.
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    let closed: Promise<void> | undefined;
    try {
      const dial = dialTunnel(
        {
          gatewayUrl: `ws://127.0.0.1:${port}/v2/host-tunnel`,
          hostId: "host-1",
          credential: "cred-1",
          generation: 1,
        },
        {
          handshakeTimeoutMs: 1_000,
          userAgent: "amika-hostd/test",
          connect: (url, options) => {
            const socket = new WebSocketClient(url, options.protocols, options);
            // Not `events.once`: it adds an `error` listener of its own,
            // and that listener would hide the defect under test.
            closed = new Promise((resolve) =>
              socket.once("close", () => resolve()),
            );
            return socket;
          },
        },
      );

      const error = await dial.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TunnelUnavailable);
      expect((error as TunnelUnavailable).status).toBe(503);
      // `ws` emits `error` and then `close` on a later tick. An `error`
      // with no listener throws there, and `close` never comes.
      await closed;
    } finally {
      server.close();
    }
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
