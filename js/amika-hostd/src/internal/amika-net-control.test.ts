import { mkdtempSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal, RulesPayload } from "@amika/iroh-rules";
import { startControlServer, type ControlServer } from "./amika-net-control.js";
import { irohAccess } from "./iroh-access.js";
import { memoryRigOwners } from "./rig-owners.js";
import { ENDPOINTS, basePayload } from "../testing/iroh.js";

/** A rig `user_ports` owns, publishing ports 22 and 8080. */
const OWNED_RIG = "rig-ports";
/** A rig with no owner. */
const UNOWNED_RIG = "rig-shared";
/** A stopped rig: it exists, and publishes nothing now. */
const STOPPED_RIG = "rig-stopped";
const API_PORT = 41_000;
const PREVIEW_PORT = 41_001;

const running: ControlServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function harness(rules: RulesPayload | null = basePayload()) {
  const dir = mkdtempSync(path.join(tmpdir(), "hd-ctl-"));
  const socketPath = path.join(dir, "amika-net", "control.sock");
  const owners = memoryRigOwners();
  const owner: Principal = { kind: "user", id: "user_ports" };
  owners.set(OWNED_RIG, owner);
  const published: Record<string, Record<number, number>> = {
    [OWNED_RIG]: { 22: 40_022, 8080: 40_080, 3000: 40_300 },
    [UNOWNED_RIG]: { 22: 41_022 },
  };
  const ready = vi.fn();
  const homeRelay = vi.fn();
  const access = irohAccess({
    rules: () => rules,
    owners,
    rigExists: async (rig) => rig in published || rig === STOPPED_RIG,
    hostPort: async (rig, port) => published[rig]?.[port] ?? null,
    apiPort: () => API_PORT,
    admitPreview: () => PREVIEW_PORT,
  });
  const server = await startControlServer(socketPath, {
    ready,
    homeRelay,
    checkPeer: (id) => access.checkPeer(id),
    open: (id, target) => access.open(id, target),
  });
  running.push(server);
  const client = await amikaNet(socketPath);
  return { server, client, socketPath, ready, homeRelay };
}

/** A pretend `amika-net`: send a line, read the response with its id. */
async function amikaNet(socketPath: string) {
  const socket: Socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines: Record<string, unknown>[] = [];
  const waiting: Array<() => void> = [];
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
      waiting.splice(0).forEach((wake) => wake());
    }
  });
  const next = async (match: (line: Record<string, unknown>) => boolean) => {
    for (;;) {
      const index = lines.findIndex(match);
      if (index !== -1) return lines.splice(index, 1)[0];
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  let id = 0;
  return {
    socket,
    send: (message: Record<string, unknown>) =>
      socket.write(`${JSON.stringify(message)}\n`),
    async request(message: Record<string, unknown>) {
      const requestId = `r${++id}`;
      socket.write(`${JSON.stringify({ ...message, id: requestId })}\n`);
      return next((line) => line.id === requestId);
    },
    next,
  };
}

describe("control socket", () => {
  it("keeps its directory 0700 and its socket 0600", async () => {
    const { socketPath } = await harness();
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("passes on ready and home_relay", async () => {
    const { client, ready, homeRelay } = await harness();
    client.send({
      type: "ready",
      endpoint_id: "ab".repeat(32),
      relay_url: null,
      version: "1.2.3",
    });
    client.send({ type: "home_relay", relay_url: "https://relay.test/" });
    await vi.waitFor(() => expect(homeRelay).toHaveBeenCalled());
    expect(ready).toHaveBeenCalledWith({
      endpointId: "ab".repeat(32),
      relayUrl: null,
      version: "1.2.3",
    });
    expect(homeRelay).toHaveBeenCalledWith("https://relay.test/");
  });

  describe("check_peer", () => {
    it("allows a device, naming its principal", async () => {
      const { client } = await harness();
      expect(
        await client.request({
          type: "check_peer",
          endpoint_id: ENDPOINTS.admin,
        }),
      ).toEqual({
        id: "r1",
        allowed: true,
        kind: "device",
        principal: { kind: "user", id: "user_admin" },
      });
    });

    it("allows a service, naming it", async () => {
      const { client } = await harness();
      expect(
        await client.request({
          type: "check_peer",
          endpoint_id: ENDPOINTS.dialer,
        }),
      ).toEqual({
        id: "r1",
        allowed: true,
        kind: "service",
        service: "dialer",
      });
    });

    it("refuses an unknown key", async () => {
      const { client } = await harness();
      expect(
        await client.request({
          type: "check_peer",
          endpoint_id: ENDPOINTS.stranger,
        }),
      ).toEqual({ id: "r1", allowed: false });
    });

    it("refuses every key before hostd holds rules", async () => {
      const { client } = await harness(null);
      expect(
        await client.request({
          type: "check_peer",
          endpoint_id: ENDPOINTS.admin,
        }),
      ).toEqual({ id: "r1", allowed: false });
    });
  });

  describe("open", () => {
    const open = async (endpoint: string, target: string) => {
      const { client } = await harness();
      return client.request({ type: "open", endpoint_id: endpoint, target });
    };

    it("connects a device to a rig's published loopback port", async () => {
      expect(await open(ENDPOINTS.admin, `rig:${UNOWNED_RIG}:22`)).toEqual({
        id: "r1",
        ok: true,
        connect: "127.0.0.1:41022",
      });
    });

    it("connects an owner to its own rig", async () => {
      expect(await open(ENDPOINTS.ports, `rig:${OWNED_RIG}:8080`)).toEqual({
        id: "r1",
        ok: true,
        connect: "127.0.0.1:40080",
      });
    });

    it("connects the dialer to the preview listener", async () => {
      expect(await open(ENDPOINTS.dialer, "hostd")).toEqual({
        id: "r1",
        ok: true,
        connect: `127.0.0.1:${PREVIEW_PORT}`,
      });
    });

    it("connects the control plane to hostd's API listener", async () => {
      expect(await open(ENDPOINTS.controlPlane, "hostd")).toEqual({
        id: "r1",
        ok: true,
        connect: `127.0.0.1:${API_PORT}`,
      });
    });

    it.each([
      [
        "not_allowed: a stranger",
        ENDPOINTS.stranger,
        `rig:${UNOWNED_RIG}:22`,
        "not_allowed",
      ],
      [
        "not_allowed: a rig the member does not own",
        ENDPOINTS.member,
        `rig:${UNOWNED_RIG}:22`,
        "not_allowed",
      ],
      [
        "not_allowed: a device asking for hostd",
        ENDPOINTS.admin,
        "hostd",
        "not_allowed",
      ],
      [
        "not_allowed: a service asking for a rig",
        ENDPOINTS.dialer,
        `rig:${UNOWNED_RIG}:22`,
        "not_allowed",
      ],
      [
        "not_allowed: a target that does not parse",
        ENDPOINTS.admin,
        "rig:../etc:22",
        "not_allowed",
      ],
      [
        "port_not_allowed: a port the role leaves out",
        ENDPOINTS.ports,
        `rig:${OWNED_RIG}:3000`,
        "port_not_allowed",
      ],
      [
        "unknown_rig: a rig this host does not have",
        ENDPOINTS.admin,
        "rig:no-such-rig:22",
        "unknown_rig",
      ],
      [
        "unreachable: a port the rig does not publish",
        ENDPOINTS.admin,
        `rig:${UNOWNED_RIG}:5432`,
        "unreachable",
      ],
      [
        "unreachable: a stopped rig",
        ENDPOINTS.admin,
        `rig:${STOPPED_RIG}:22`,
        "unreachable",
      ],
    ])("refuses with %s", async (_name, endpoint, target, reason) => {
      expect(await open(endpoint, target)).toEqual({
        id: "r1",
        ok: false,
        reason,
      });
    });

    it("tells a member nothing about rigs it may not reach", async () => {
      expect(await open(ENDPOINTS.member, "rig:no-such-rig:22")).toEqual({
        id: "r1",
        ok: false,
        reason: "not_allowed",
      });
    });
  });

  it("sends revoke to amika-net", async () => {
    const { server, client } = await harness();
    server.revoke([ENDPOINTS.member]);
    expect(await client.next((line) => line.type === "revoke")).toEqual({
      type: "revoke",
      endpoint_ids: [ENDPOINTS.member],
    });
  });

  it("ignores a line it cannot read and answers the next", async () => {
    const { client } = await harness();
    client.socket.write("not json\n");
    client.send({ type: "mystery" });
    expect(
      await client.request({
        type: "check_peer",
        endpoint_id: ENDPOINTS.admin,
      }),
    ).toMatchObject({ allowed: true });
  });
});
