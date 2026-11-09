import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IrohRulesAnswer } from "./amika-api.js";
import { memoryRigOwners } from "./rig-owners.js";
import {
  readAmikaNetState,
  startIrohTransport,
  type IrohTransport,
} from "./iroh-transport.js";
import type { AmikaNetReport } from "./runtimes.js";
import {
  AMIKA_KEY,
  ENDPOINTS,
  FAKE_ENDPOINT_ID,
  basePayload,
  signed,
  writeFakeAmikaNet,
} from "../testing/iroh.js";

/** RFC 8032's test key 2, standing in for the host key. */
const HOST_KEY_HEX =
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const transports: IrohTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.stop()));
});

async function harness({
  answers = [],
  allowed = true,
  mode,
}: {
  answers?: IrohRulesAnswer[];
  allowed?: boolean;
  mode?: "exit";
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hd-iroh-"));
  const fakeOut = path.join(dir, "fake");
  mkdirSync(fakeOut);
  mkdirSync(path.join(dir, "bin"));
  const out: string[] = [];
  const err: string[] = [];
  const fetchRules = vi.fn(
    async (_have: number | null): Promise<IrohRulesAnswer> =>
      answers.shift() ?? { kind: "unchanged" },
  );
  const report = vi.fn(async (_amikaNet: AmikaNetReport) => ({ allowed }));
  const paths = {
    socketPath: path.join(dir, "amika-net", "control.sock"),
    rulesFile: path.join(dir, "iroh-rules.json"),
    stateFile: path.join(dir, "amika-net.json"),
    logFile: path.join(dir, "amika-net.log"),
  };
  const transport = await startIrohTransport({
    hostKey: Uint8Array.from(Buffer.from(HOST_KEY_HEX, "hex")),
    binary: writeFakeAmikaNet(path.join(dir, "bin")),
    orgId: "org_vectors",
    trustedKeys: [AMIKA_KEY.public_hex],
    paths,
    env: {
      PATH: process.env.PATH,
      FAKE_AMIKA_NET_OUT: fakeOut,
      ...(mode ? { FAKE_AMIKA_NET_MODE: mode } : {}),
    },
    fetchRules,
    report,
    access: {
      owners: memoryRigOwners(),
      rigExists: async () => true,
      hostPort: async () => null,
      apiPort: () => undefined,
      admitPreview: () => undefined,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    rulesIntervalMs: 50,
    supervisor: { restartDelayMs: 20, maxRestartDelayMs: 40 },
  });
  transports.push(transport);
  const read = (name: string) =>
    existsSync(path.join(fakeOut, name))
      ? readFileSync(path.join(fakeOut, name), "utf8")
      : "";
  const starts = () =>
    read("starts")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { key: string; pid: number });
  return {
    transport,
    answers,
    fetchRules,
    report,
    out,
    err,
    paths,
    read,
    starts,
  };
}

describe("startIrohTransport", () => {
  it("starts amika-net with the host key and reports it once ready", async () => {
    const h = await harness();
    await vi.waitFor(() => expect(h.report).toHaveBeenCalled());
    expect(h.starts()[0].key).toBe(HOST_KEY_HEX);
    expect(h.report).toHaveBeenCalledWith({
      endpoint_id: FAKE_ENDPOINT_ID,
      relay_url: null,
      version: "0.0.0-test",
    });
    expect(readAmikaNetState(h.paths.stateFile)).toEqual({
      endpoint_id: FAKE_ENDPOINT_ID,
      relay_url: null,
      version: "0.0.0-test",
    });
    expect([...h.out, ...h.err].join("\n")).not.toContain(HOST_KEY_HEX);
  });

  it("fetches rules at once and revokes what newer rules drop", async () => {
    const newer = basePayload();
    newer.version = 43;
    newer.devices = newer.devices.filter(
      (d) => d.endpoint_id !== ENDPOINTS.member,
    );
    const h = await harness({
      answers: [{ kind: "rules", envelope: await signed(basePayload()) }],
    });
    // Once amika-net is connected, so the revoke has somewhere to go.
    await vi.waitFor(() => expect(h.report).toHaveBeenCalled());
    h.answers.push({ kind: "rules", envelope: await signed(newer) });
    await vi.waitFor(() => expect(h.read("received")).toContain("revoke"));
    expect(JSON.parse(h.read("received").trim())).toEqual({
      type: "revoke",
      endpoint_ids: [ENDPOINTS.member],
    });
    expect(h.fetchRules.mock.calls[0]).toEqual([null]);
    expect(h.fetchRules).toHaveBeenCalledWith(42);
  });

  it("restarts amika-net when it exits", async () => {
    const h = await harness({ mode: "exit" });
    await vi.waitFor(() => expect(h.starts().length).toBeGreaterThan(2));
  });

  it("stops amika-net when the org no longer allows tunnel_iroh", async () => {
    const h = await harness();
    await vi.waitFor(() => expect(h.report).toHaveBeenCalled());
    h.answers.push({ kind: "not_allowed" });
    await h.transport.stopped;
    expect(() => process.kill(h.starts()[0].pid, 0)).toThrow();
    expect(existsSync(h.paths.stateFile)).toBe(false);
    expect(existsSync(h.paths.socketPath)).toBe(false);
    expect(h.out.join("\n")).toContain("no longer allows tunnel_iroh");
  });

  it("stops amika-net when a report says the org no longer allows it", async () => {
    const h = await harness({ allowed: false });
    await h.transport.stopped;
    expect(h.report).toHaveBeenCalledOnce();
    expect(() => process.kill(h.starts()[0].pid, 0)).toThrow();
  });
});
