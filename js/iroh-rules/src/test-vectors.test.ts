import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkPeer,
  checkTarget,
  parseEndpointId,
  parseTarget,
  verifyRules,
  type RulesPayload,
} from "./index";
import {
  buildTestVectors,
  type TestVectors,
} from "./testing/build-test-vectors";

const VECTORS_PATH = new URL("../test-vectors.json", import.meta.url);

const committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as TestVectors;

describe("test-vectors.json", () => {
  it("matches what the builder makes", async () => {
    const built = await buildTestVectors();
    if (process.env.UPDATE_TEST_VECTORS === "1") {
      writeFileSync(VECTORS_PATH, `${JSON.stringify(built, null, 2)}\n`);
      return;
    }
    expect(committed).toEqual(JSON.parse(JSON.stringify(built)));
  });
});

describe("verify vectors", () => {
  it.each(committed.verify.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const o = vector.options;
      const result = await verifyRules(vector.envelope, {
        trustedKeys: o.trusted_keys,
        trustedKinds: o.trusted_kinds,
        orgId: o.org_id,
        haveVersion: o.have_version,
        knownFormats: o.known_formats,
        knownFeatures: o.known_features,
      });
      if (vector.expect.ok) {
        expect(result).toMatchObject({
          ok: true,
          signer: { key_id: vector.expect.key_id, kind: vector.expect.kind },
          rules: { version: vector.expect.version },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          reason: vector.expect.reason,
        });
      }
    },
  );
});

describe("check_peer vectors", () => {
  it.each(committed.check_peer.map((v) => [v.name, v] as const))(
    "%s",
    (_name, vector) => {
      const result = checkPeer(payload(vector.payload), vector.endpoint_id);
      const expected = vector.expect;
      if (!expected.allowed) {
        expect(result).toEqual({ allowed: false });
      } else if (expected.kind === "device") {
        expect(result).toMatchObject({
          allowed: true,
          kind: "device",
          device: { device_id: expected.device_id },
          principal: { kind: "user", id: expected.principal_id },
        });
      } else {
        expect(result).toMatchObject({
          allowed: true,
          kind: "service",
          service: { service: expected.service },
        });
      }
    },
  );
});

describe("check_target vectors", () => {
  it.each(committed.check_target.map((v) => [v.name, v] as const))(
    "%s",
    (_name, vector) => {
      const rules = payload(vector.payload);
      const peer = checkPeer(rules, vector.endpoint_id);
      const target = parseTarget(vector.target);
      if (!peer.allowed || target === null) {
        throw new Error("a check_target vector needs a peer and a target");
      }
      expect(checkTarget(rules, peer, target, vector.rig_owner)).toEqual(
        vector.expect,
      );
    },
  );
});

describe("parse_target vectors", () => {
  it.each(committed.parse_target.map((v) => [JSON.stringify(v.input), v]))(
    "%s",
    (_name, vector) => {
      const expected =
        vector.expect?.kind === "rig"
          ? {
              kind: "rig",
              rigId: vector.expect.rig_id,
              port: vector.expect.port,
            }
          : vector.expect;
      expect(parseTarget(vector.input)).toEqual(expected);
    },
  );
});

describe("parse_endpoint_id vectors", () => {
  it.each(committed.parse_endpoint_id.map((v) => [JSON.stringify(v.input), v]))(
    "%s",
    (_name, vector) => {
      expect(parseEndpointId(vector.input)).toBe(
        vector.valid ? vector.input : null,
      );
    },
  );
});

function payload(name: string): RulesPayload {
  const found = committed.payloads[name];
  if (found === undefined) throw new Error(`no payload ${name}`);
  return found;
}
