/**
 * Opening the WebSocket to the gateway, and reading what the answer means.
 *
 * Everything here happens before a single yamux byte moves. It is the only
 * place the attachment credential is written to a socket, and the only place
 * the gateway gets to refuse this host with a reason an operator can act on.
 */
import { WebSocket, type ClientOptions } from "ws";
import type { IncomingMessage } from "node:http";
import { DEFAULT_LIMITS, type TunnelLimits } from "./tunnel-attachment.js";

/**
 * The subprotocol this daemon speaks. The version is in the name because
 * there is nowhere else to put it: the connection carries binary frames
 * only, and a text control message is exactly what the gateway refuses.
 *
 * A gateway that does not echo it has not agreed to this protocol, and the
 * bytes that follow would be read by something that is not a yamux peer.
 */
export const TUNNEL_SUBPROTOCOL = "amika.tunnel.v1";

/**
 * Header names this handshake uses, in the spelling the gateway reads and
 * writes (amika-mono `js/gateway/src/internal/host-listener.ts`). The
 * gateway refuses a dial that does not name the host and carry the
 * credential in exactly these.
 */
export const HOST_ID_HEADER = "x-amika-host-id";
export const CREDENTIAL_HEADER = "x-amika-host-credential";
export const CONNECTION_ID_HEADER = "x-amika-connection-id";
/** Read when present. The gateway does not send it today. */
export const PUBLIC_URL_HEADER = "x-amika-host-url";

export interface TunnelTarget {
  /** The gateway's attachment endpoint, `wss://` outside development. */
  gatewayUrl: string;
  /** This host's durable Amika id. The gateway confirms it; it is not proof. */
  hostId: string;
  /**
   * The host-scoped attachment credential. Opaque to the gateway, which
   * passes it to the control plane and never parses it.
   */
  credential: string;
  /**
   * Which rotation of that credential this is. Held here so the daemon can
   * refuse to dial with one it has already replaced; the gateway learns the
   * generation from the control plane and not from this.
   */
  generation: number;
}

/**
 * The gateway refused this host, and dialling again with the same
 * credential will be refused the same way. An operator has to re-enrol or
 * restore the host.
 */
export class TunnelRejected extends Error {
  override name = "TunnelRejected";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The gateway could not be reached, or did not finish the handshake. */
export class TunnelUnavailable extends Error {
  override name = "TunnelUnavailable";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DialedTunnel {
  ws: WebSocket;
  /**
   * The gateway's id for this attachment, if it sent one. Reported in
   * logs and in the daemon's readiness result, and the value an operator
   * needs to match a host's session against the gateway's own records.
   *
   * Optional because the gateway that exists today mints this id after it
   * has accepted the WebSocket, so it has no 101 to put it on. See
   * `docs/tunnel.md`.
   */
  connectionId?: string;
  /** The public address the gateway assigned this host, if it sent one. */
  publicUrl?: string;
}

export interface DialOptions {
  limits?: TunnelLimits;
  /** How long the HTTP handshake may take. */
  handshakeTimeoutMs: number;
  /** What this daemon calls itself to the gateway. */
  userAgent: string;
  /** Injected in tests. */
  connect?: (url: string, options: ConnectOptions) => WebSocket;
}

export interface ConnectOptions extends ClientOptions {
  protocols: string[];
}

/**
 * Open one attachment connection, or throw something that says whether to
 * try again.
 */
export async function dialTunnel(
  target: TunnelTarget,
  options: DialOptions,
): Promise<DialedTunnel> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const url = requireSecureGateway(target.gatewayUrl);
  const connect =
    options.connect ??
    ((at, settings) => new WebSocket(at, settings.protocols, settings));
  const ws = connect(url, {
    protocols: [TUNNEL_SUBPROTOCOL],
    headers: {
      // The credential goes in a header and never in the URL. A query
      // string reaches the access log of every proxy on the path, and an
      // attachment credential lives until it is rotated.
      //
      // A header of its own, not `Authorization: Bearer`: the gateway does
      // not know the credential's scheme and passes the whole value to the
      // control plane unread, so it asks for the value alone.
      [CREDENTIAL_HEADER]: target.credential,
      [HOST_ID_HEADER]: target.hostId,
      "user-agent": options.userAgent,
    },
    // The gateway writes at its own message size and this end splits at
    // the same one, so an inbound message far above that is a peer that is
    // not the gateway, or one that is wrong. `ws` assembles a whole
    // message before the frame guard can see a byte of it, so this is the
    // only bound on that memory.
    maxPayload: limits.maxFrameBytes,
    // Deliberate. Compression on a multiplexed tunnel costs CPU on every
    // host and leaks the size of inner traffic across streams, and the
    // bodies that matter here are already compressed.
    perMessageDeflate: false,
    // A redirect would resend the attachment credential to whatever the
    // `Location` named. `ws` defaults this off; it is stated because the
    // default changing would be silent.
    followRedirects: false,
    handshakeTimeout: options.handshakeTimeoutMs,
  });

  return new Promise<DialedTunnel>((resolve, reject) => {
    let settled = false;
    /**
     * The gateway's `101`, kept from the `upgrade` event. `ws` raises it
     * before `open`, and it is the only place the handshake's own headers
     * are visible.
     */
    let handshake: IncomingMessage | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      ws.removeListener("upgrade", onUpgrade);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
      ws.removeListener("unexpected-response", onUnexpected);
      finish();
    };

    const onUpgrade = (response: IncomingMessage) => {
      handshake = response;
    };

    const onOpen = () =>
      settle(() => {
        // `ws` leaves `protocol` empty when the server echoed nothing. The
        // bytes after this point are read as yamux frames by whatever is at
        // the other end, so a peer that did not agree to this protocol is
        // refused here rather than fed a frame stream.
        if (ws.protocol !== TUNNEL_SUBPROTOCOL) {
          ws.close(1002, "subprotocol");
          reject(
            new TunnelUnavailable(
              `Gateway did not accept the ${TUNNEL_SUBPROTOCOL} subprotocol (answered ${ws.protocol === "" ? "none" : ws.protocol})`,
            ),
          );
          return;
        }
        resolve({
          ws,
          connectionId: header(handshake, CONNECTION_ID_HEADER),
          publicUrl: header(handshake, PUBLIC_URL_HEADER),
        });
      });

    const onError = (error: Error) =>
      settle(() => reject(new TunnelUnavailable(error.message)));

    const onUnexpected = (_request: unknown, response: IncomingMessage) =>
      settle(() => {
        // The socket is this side's to clean up: `ws` hands over the
        // response and does nothing else with the connection.
        response.destroy();
        ws.terminate();
        reject(refusal(response.statusCode ?? 0));
      });

    ws.once("upgrade", onUpgrade);
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("unexpected-response", onUnexpected);
  });
}

/**
 * What a gateway's HTTP status means for the next attempt.
 *
 * The split is the same one the gateway makes internally between
 * `"rejected"` and `"unavailable"`, and for the same reason: a refusal
 * means stop and tell the operator, and an outage means wait and dial
 * again. Collapsing them either hides a revoked credential behind an
 * endless retry, or takes a working host offline because the control plane
 * hiccuped once.
 */
export function refusal(status: number): TunnelRejected | TunnelUnavailable {
  switch (status) {
    case 401:
      return new TunnelRejected(
        "The gateway did not accept this host's attachment credential. Run `amika-hostd setup` to enrol this host again.",
        status,
      );
    case 403:
      return new TunnelRejected(
        "This host is not allowed to attach. Its credential may have been revoked, or the host switched to listener mode.",
        status,
      );
    case 404:
    case 410:
      return new TunnelRejected(
        "Amika has no record of this host. It may have been deleted; run `amika-hostd setup` to register it again.",
        status,
      );
    case 426:
      return new TunnelRejected(
        `The gateway does not speak ${TUNNEL_SUBPROTOCOL}. Upgrade amika-hostd.`,
        status,
      );
    default:
      // Everything else, 429 and 5xx included, is the gateway or something
      // in front of it having a bad moment. The credential is not in
      // question, so there is nothing for an operator to do but wait.
      return new TunnelUnavailable(
        `Gateway answered ${status} to the attachment handshake`,
        status,
      );
  }
}

/**
 * Refuse a gateway address that would put the credential on the wire in
 * clear, or send it somewhere other than a WebSocket.
 *
 * Loopback is allowed because a developer running a gateway on their own
 * machine has no certificate for it, and because nothing leaves the
 * machine. Any other `ws://` is refused: the credential authorizes
 * receiving this host's traffic, and a hostname that resolves somewhere
 * unexpected is exactly the case this stops.
 */
export function requireSecureGateway(url: string): string {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TunnelRejected(`Gateway URL is not a URL: ${url}`, 0);
  }
  if (parsed.protocol === "wss:") return parsed.toString();
  if (parsed.protocol === "ws:" && isLoopback(parsed.hostname)) {
    return parsed.toString();
  }
  throw new TunnelRejected(
    `Gateway URL must be wss:// (ws:// is allowed on loopback only), not ${url}`,
    0,
  );
}

function isLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  // Anchored at both ends. A prefix test lets `127.0.0.1.evil.example`
  // through, and that is a name an attacker can register, so the exception
  // for a developer's own machine would become a way to send a host's
  // attachment credential anywhere in clear.
  return (
    bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare)
  );
}

/** One header from the gateway's `101`, lowercased by Node already. */
function header(
  handshake: IncomingMessage | undefined,
  name: string,
): string | undefined {
  const value = handshake?.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
