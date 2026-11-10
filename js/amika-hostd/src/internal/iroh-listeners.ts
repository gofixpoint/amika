/**
 * The two loopback listeners `amika-net`'s `hostd` target reaches (spec
 * 035, `iroh-contracts.md`, "hostd and `amika-net`: the control socket"):
 *
 * - **The API listener**, for the `control_plane` service: hostd's API, as
 *   a listening daemon serves it. The host key is checked there, and the
 *   rig headers are anybody's, so they are ignored.
 * - **The preview listener**, for the `dialer` service: it serves a stream
 *   as the tunnel's server does. `x-amika-rig` and `x-amika-service` are
 *   the dialer's word, as they are the gateway's on the tunnel, and every
 *   other `x-amika-` header is removed.
 *
 * Both bind only to loopback. The preview listener trusts what it reads,
 * so it takes a connection only when hostd has just answered a dialer's
 * `open` with its address: each answer admits one connection, for a short
 * time. Any other connection is closed at once.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { serveHandlers, type buildHandlers } from "./server.js";
import { virtualServer } from "./tunnel-serving.js";

export interface IrohListeners {
  /** The API listener's port. */
  readonly apiPort: number;
  /**
   * The preview listener's port, admitting one connection in the next
   * `PREVIEW_ADMIT_MS`. Call it once for each dialer `open` it answers.
   */
  admitPreview(): number;
  close(): Promise<void>;
}

/** How long one dialer `open` answer admits a connection for. */
export const PREVIEW_ADMIT_MS = 10_000;

export async function startIrohListeners(
  handlers: ReturnType<typeof buildHandlers>,
  { admitMs = PREVIEW_ADMIT_MS }: { admitMs?: number } = {},
): Promise<IrohListeners> {
  const api = await serveHandlers(handlers, {
    hostname: "127.0.0.1",
    port: 0,
  });
  const preview = virtualServer({
    fetch: handlers.app.fetch,
    upgrade: handlers.upgrade,
    dropForeignAmikaHeaders: true,
  });
  /** When each outstanding admission runs out, oldest first. */
  const admitted: number[] = [];
  const sockets = new Set<Socket>();
  const listener = createServer((socket) => {
    const now = Date.now();
    while (admitted.length > 0 && admitted[0] <= now) admitted.shift();
    if (admitted.shift() === undefined) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    preview.accept(socket);
  });
  const previewPort = await listenOnLoopback(listener);
  return {
    apiPort: api.port,
    admitPreview() {
      admitted.push(Date.now() + admitMs);
      return previewPort;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      preview.close();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await api.close();
    },
  };
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
