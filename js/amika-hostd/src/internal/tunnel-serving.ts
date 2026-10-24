/**
 * Serving HTTP on connections that no listener produced.
 *
 * Tunnel mode binds no port. The gateway hands this daemon a connection at
 * a time, already inside the WebSocket, and those connections have to reach
 * the same routes, the same authentication and the same upgrade handler
 * that a listening socket reaches. Anything else is a second serving path
 * that drifts from the first, and the one that drifts is the one that
 * serves the internet.
 *
 * So there is no second path. This builds an ordinary `node:http` server
 * around the same request listener, never calls `listen`, and pushes each
 * tunnel connection into it with the `connection` event -- which is exactly
 * what `net.Server` does when a real socket arrives. Node's parser, its
 * `upgrade` handling and its `Connection` rules all work the same way,
 * because to Node nothing is different.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";

export interface VirtualServerOptions {
  /** The Hono app's handler, the same one `startServer` serves. */
  fetch: Parameters<typeof getRequestListener>[0];
  /** The same upgrade handler a listening daemon installs. */
  upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export interface VirtualServer {
  /** Serve one connection the gateway opened. */
  accept(socket: Duplex): void;
  /** Stop serving. Connections already accepted are the caller's to end. */
  close(): void;
}

/**
 * An HTTP server with no socket under it.
 *
 * Two things are deliberately absent, because `listen` is what installs
 * them. Node's `headersTimeout` and `requestTimeout` are driven by a
 * connection-tracking interval that `listen` starts, so they do not run
 * here. On a listening daemon they defend against a stranger trickling
 * headers; on this path the only peer is the gateway, which has already
 * authenticated and which bounds its own forwarding deadline. The second is
 * `server.close()`, which reports `ERR_SERVER_NOT_RUNNING` on a server that
 * never listened -- see `close` below.
 */
export function virtualServer(options: VirtualServerOptions): VirtualServer {
  const server: Server = createServer(getRequestListener(options.fetch));
  if (options.upgrade) server.on("upgrade", options.upgrade);
  return {
    accept(socket: Duplex): void {
      server.emit("connection", socket);
    },
    close(): void {
      // Not `server.close()`: it is only meaningful for a listening socket,
      // and it calls back with `ERR_SERVER_NOT_RUNNING` here. Draining the
      // connections is `TunnelAttachment.close`'s job, because the streams
      // they sit on are the attachment's and not this server's.
      server.removeAllListeners("upgrade");
    },
  };
}
