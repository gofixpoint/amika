/**
 * Test fixtures for the iroh transport: `@amika/iroh-rules`'s test vectors
 * and their RFC 8032 test keys, records signed with them, and a fake
 * `amika-net` that speaks the control socket contract. Never real keys.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  encodePayload,
  signRules,
  type RulesEnvelope,
  type RulesPayload,
} from "@amika/iroh-rules";

interface Vectors {
  keys: Record<
    "amika" | "other" | "org_admin",
    { seed_hex: string; public_hex: string }
  >;
  payloads: { base: RulesPayload };
}

const VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../iroh-rules/test-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

/** RFC 8032's test key 1, the vectors' `amika` signer. */
export const AMIKA_KEY = VECTORS.keys.amika;
/** RFC 8032's test key 2, which no test host trusts. */
export const OTHER_KEY = VECTORS.keys.other;

/** The vectors' base payload: org `org_vectors`, version 42. */
export function basePayload(): RulesPayload {
  return structuredClone(VECTORS.payloads.base);
}

/** The endpoint ids in the base payload, by role. */
export const ENDPOINTS = {
  /** `user_admin`'s device: role `admin`, all rigs, all ports. */
  admin: "a1".repeat(32),
  /** `user_member`'s device: role `member`, own rigs, all ports. */
  member: "b2".repeat(32),
  /** `user_ports`'s device: role `ssh_only`, own rigs, ports 22 and 8080. */
  ports: "c3".repeat(32),
  /** The `dialer` service: the `hostd` target only. */
  dialer: "e5".repeat(32),
  /** The `control_plane` service: the `hostd` target only. */
  controlPlane: "f6".repeat(32),
  /** In no rules. */
  stranger: "99".repeat(32),
} as const;

/** `payload`, signed by `seed` (hex) as the `amika` signer. */
export async function signed(
  payload: RulesPayload,
  seedHex: string = AMIKA_KEY.seed_hex,
): Promise<RulesEnvelope> {
  return signRules(encodePayload(payload), {
    kind: "amika",
    privateKey: Uint8Array.from(Buffer.from(seedHex, "hex")),
  });
}

/** The endpoint id the fake `amika-net` reports. */
export const FAKE_ENDPOINT_ID = "5e".repeat(32);

/**
 * Write a fake `amika-net` into `dir` and return its path. It runs on this
 * Node. Each start appends `{ args, key, pid }` to `<out>/starts`, with the
 * key it read from fd 3 as hex; it connects to the control socket, sends
 * `ready`, and appends every line hostd sends to `<out>/received`.
 *
 * `FAKE_AMIKA_NET_OUT` names `<out>`. `FAKE_AMIKA_NET_MODE=exit` makes it
 * exit with code 3 right after it reads the key.
 */
export function writeFakeAmikaNet(dir: string): string {
  const file = path.join(dir, "amika-net");
  writeFileSync(file, `#!${process.execPath}\n${FAKE_SOURCE}`);
  chmodSync(file, 0o755);
  return file;
}

const FAKE_SOURCE = `
const fs = require("node:fs");
const net = require("node:net");
const out = process.env.FAKE_AMIKA_NET_OUT;
const args = process.argv.slice(2);
const key = Buffer.alloc(32);
let got = 0;
while (got < 32) {
  let n;
  try {
    n = fs.readSync(3, key, got, 32 - got, null);
  } catch (error) {
    if (error.code !== "EAGAIN") throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    continue;
  }
  if (n === 0) break;
  got += n;
}
fs.closeSync(3);
fs.appendFileSync(
  out + "/starts",
  JSON.stringify({ args, key: key.subarray(0, got).toString("hex"), pid: process.pid }) + "\\n",
);
if (process.env.FAKE_AMIKA_NET_MODE === "exit") process.exit(3);
process.on("SIGTERM", () => process.exit(0));
const socket = net.connect(args[args.indexOf("--control-socket") + 1]);
socket.on("connect", () => {
  socket.write(
    JSON.stringify({
      type: "ready",
      endpoint_id: "${FAKE_ENDPOINT_ID}",
      relay_url: null,
      version: "0.0.0-test",
    }) + "\\n",
  );
});
socket.on("data", (data) => fs.appendFileSync(out + "/received", data));
socket.on("error", () => {});
setInterval(() => {}, 1000);
`;
