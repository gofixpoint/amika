/**
 * hostd's side of the control socket to `amika-net` (spec 035,
 * `iroh-contracts.md`, "hostd and `amika-net`: the control socket").
 *
 * hostd creates a Unix socket in its state directory, in a directory of
 * mode 0700, and listens. `amika-net host` connects to it. Messages are
 * JSON, one for each line. A request has an `id`, and its response carries
 * the same `id`.
 *
 * - From `amika-net`: `ready` and `home_relay`, which need no response;
 *   `check_peer` (check 1) and `open` (check 2), which do.
 * - From hostd: `revoke`, which closes every connection from the endpoints
 *   it names.
 *
 * This module moves the messages. What the answers are is
 * `iroh-access.ts`'s.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { z } from "zod";
import type { OpenAnswer, PeerAnswer } from "./iroh-access.js";

export interface ControlHandlers {
  /** `amika-net` is serving as `endpointId`; sent after each connect. */
  ready(info: {
    endpointId: string;
    relayUrl: string | null;
    version: string;
  }): void;
  /** `amika-net`'s home relay changed. */
  homeRelay(relayUrl: string): void;
  /** Check 1, for a new connection from `endpointId`. */
  checkPeer(endpointId: string): PeerAnswer;
  /** Check 2, for a stream from `endpointId` to `target`. */
  open(endpointId: string, target: string): Promise<OpenAnswer>;
  /** A line hostd could not read, for the log. Never the line itself. */
  warn?: (line: string) => void;
}

export interface ControlServer {
  /** The socket's path, for `amika-net --control-socket`. */
  readonly socketPath: string;
  /** Send `revoke` to every connected `amika-net`. */
  revoke(endpointIds: readonly string[]): void;
  /** Stop listening and end every connection. */
  close(): Promise<void>;
}

/** The longest line hostd reads. A longer one ends the connection. */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Listen on `socketPath`. Its directory is created, or made, mode 0700, so
 * only hostd's user reaches the socket. A socket left by an earlier run is
 * replaced; any other file there is an error.
 */
export async function startControlServer(
  socketPath: string,
  handlers: ControlHandlers,
): Promise<ControlServer> {
  prepareSocketPath(socketPath);
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveConnection(socket, handlers);
  });
  await listen(server, socketPath);
  chmodSync(socketPath, 0o600);
  return {
    socketPath,
    revoke(endpointIds) {
      if (endpointIds.length === 0) return;
      const line = `${JSON.stringify({ type: "revoke", endpoint_ids: endpointIds })}\n`;
      for (const socket of connections) {
        if (!socket.destroyed) socket.write(line);
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

/** Make the socket's directory private, and clear a stale socket. */
function prepareSocketPath(socketPath: string): void {
  const dir = path.dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mkdirSync` leaves an existing directory's mode alone.
  chmodSync(dir, 0o700);
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket`);
  }
  rmSync(socketPath);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Read lines from one `amika-net` and answer each request on it. */
function serveConnection(socket: Socket, handlers: ControlHandlers): void {
  const warn = handlers.warn ?? (() => {});
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end === -1) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim() !== "") void handleLine(line);
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
      warn("amika-net sent a control line that is too long; closing it");
      socket.destroy();
    }
  });

  async function handleLine(line: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      warn("amika-net sent a control line that is not JSON");
      return;
    }
    const parsed = messageSchema.safeParse(json);
    if (!parsed.success) {
      warn("amika-net sent a control message hostd does not know");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ready":
        handlers.ready({
          endpointId: message.endpoint_id,
          relayUrl: message.relay_url ?? null,
          version: message.version,
        });
        return;
      case "home_relay":
        handlers.homeRelay(message.relay_url);
        return;
      case "check_peer":
        reply({ id: message.id, ...handlers.checkPeer(message.endpoint_id) });
        return;
      case "open": {
        let answer: OpenAnswer;
        try {
          answer = await handlers.open(message.endpoint_id, message.target);
        } catch {
          answer = { ok: false, reason: "unreachable" };
        }
        reply({ id: message.id, ...answer });
        return;
      }
      default:
        assertNever(message);
    }
  }

  function reply(answer: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(answer)}\n`);
  }
}

/** A request id, echoed back as it came. */
const idSchema = z.union([z.string(), z.number()]);

const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    endpoint_id: z.string(),
    relay_url: z.string().nullable().optional(),
    version: z.string(),
  }),
  z.object({ type: z.literal("home_relay"), relay_url: z.string() }),
  z.object({
    type: z.literal("check_peer"),
    id: idSchema,
    endpoint_id: z.string(),
  }),
  z.object({
    type: z.literal("open"),
    id: idSchema,
    endpoint_id: z.string(),
    target: z.string(),
  }),
]);

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
