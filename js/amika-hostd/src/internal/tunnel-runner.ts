/**
 * The daemon, reached by dialling out instead of by listening.
 *
 * The counterpart of `startServer`, and deliberately as thin. Both build
 * the same app and the same upgrade handler through `buildHandlers`, so a
 * rig served down a tunnel answers the same routes, under the same
 * authorization, as one served on a port. A second assembly here would be
 * a second upgrade policy, and the one that drifted would be the one
 * nobody was looking at.
 *
 * What differs is where connections come from. A listener waits for them;
 * this opens one WebSocket to the gateway and serves the streams
 * the gateway opens back down it. `virtualServer` is the HTTP server with
 * no socket under it.
 */
import type { Duplex } from "node:stream";
import { buildHandlers, type SnapshotOptions } from "./server.js";
import { virtualServer } from "./tunnel-serving.js";
import {
  TunnelClient,
  type AttachedInfo,
  type TunnelEvent,
} from "./tunnel-client.js";
import { resolveTunnelTarget, type TunnelEnrolment } from "./tunnel-target.js";
import type { HostdConfigWith } from "./config.js";
import type { Secrets } from "./credentials.js";
import type { MachineRuntime } from "./machine-runtime.js";

/** How long the daemon waits to report that it is serving. */
export const ATTACH_TIMEOUT_MS = 30_000;

export interface RunningTunnel {
  /**
   * What the gateway said when it kept this connection.
   *
   * `connectionId` is optional because the gateway only began naming it
   * on the `101` recently; a host dialling an older one attaches fine
   * and reports no id.
   */
  whenAttached(timeoutMs?: number): Promise<AttachedInfo>;
  /** Stop dialling and end what is attached. */
  close(): Promise<void>;
}

export interface StartTunnelOptions {
  servicesFile?: string;
  hiddenMachines?: () => ReadonlySet<string>;
  snapshots?: SnapshotOptions;
  onEvent?: (event: TunnelEvent) => void;
  /** What the gateway sees this daemon as. */
  userAgent?: string;
  /** Injected for tests. */
  client?: TunnelClient;
}

/**
 * Serve this host down a tunnel.
 *
 * Returns as soon as the client is dialling, not once it has attached.
 * The caller decides how long to wait for that, because the two callers
 * want different things: `serve` runs in the foreground and can report
 * progress, and `up` has an operator waiting on a prompt.
 *
 * The target is read before **every** dial rather than captured here, so
 * a credential rotated while the daemon runs is picked up on the next
 * attempt instead of at the next restart.
 */
export function startTunnel(
  config: HostdConfigWith<"secretKey">,
  runtime: MachineRuntime,
  secrets: Pick<Secrets, "attachmentCredential">,
  readEnrolment: () => TunnelEnrolment | undefined,
  options: StartTunnelOptions = {},
): RunningTunnel {
  const { app, upgrade, tunnels } = buildHandlers(config, runtime, {
    servicesFile: options.servicesFile,
    hiddenMachines: options.hiddenMachines,
    snapshots: options.snapshots,
  });
  const server = virtualServer({ fetch: app.fetch, upgrade });

  const client =
    options.client ??
    new TunnelClient({
      // Read per dial, not once. `resolveTunnelTarget` throws a
      // `ConfigError` naming what the operator must do when the host is
      // not enrolled or the credential has gone.
      target: () => resolveTunnelTarget(config, secrets, readEnrolment()),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      userAgent: options.userAgent ?? "amika-hostd",
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      pingTimeoutMs: PING_TIMEOUT_MS,
      drainMs: DRAIN_MS,
      onConnection: (socket: Duplex) => server.accept(socket),
      onEvent: options.onEvent,
    });
  client.start();

  return {
    whenAttached: (timeoutMs = ATTACH_TIMEOUT_MS) =>
      client.whenAttached(timeoutMs),
    close: async () => {
      // Upgraded connections first. An SSH session, a terminal or a
      // service's WebSocket is long-lived by design, and the attachment's
      // drain waits for every open stream, so leaving them open would spend
      // the whole drain window on them while the gateway still routes here.
      for (const tunnel of tunnels) tunnel.destroy();
      // Then the client: it stops dialling and drains the ordinary
      // requests still in flight, which is what the server below serves.
      // Closing the server first would leave the attachment opening
      // streams into a server that no longer serves them.
      await client.stop();
      server.close();
    },
  };
}

/**
 * How long one dial may take before it is abandoned and retried.
 *
 * The gateway answers a refusal with a status rather than by dropping the
 * socket, so a dial that neither completes nor fails is a network that is
 * black-holing rather than a host that is unwelcome.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * How often to ping an idle tunnel.
 *
 * A tunnel is a WebSocket held open across whatever sits between a
 * customer's network and Amika, and an idle one is what a NAT or a load
 * balancer reaps first. This is the host's half of the same bargain
 * `GATEWAY_KEEP_ALIVE_INTERVAL_MS` makes on the gateway's side.
 */
const KEEP_ALIVE_INTERVAL_MS = 30_000;

/**
 * How long a ping may go unanswered before the tunnel is treated as gone.
 *
 * Shorter than the interval, so an unanswered ping is noticed before the
 * next one is due rather than queueing behind it.
 */
const PING_TIMEOUT_MS = 10_000;

/** How long a closing attachment may take to finish what it is serving. */
const DRAIN_MS = 5_000;
