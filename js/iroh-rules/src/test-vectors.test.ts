import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkPeer,
  checkRecoveryMessage,
  checkSignedRequest,
  checkTarget,
  formatFingerprint,
  lockFingerprint,
  parseEndpointId,
  parseRecoveryCode,
  parseTarget,
  recoveryCheckValue,
  sameFingerprint,
  testRecoveryCode,
  verifyLockedRules,
  verifyLockLog,
  verifyRules,
  type LockState,
  type RulesPayload,
  type UsedOperationStore,
} from "./index";
import { fromBase64Url } from "./internal/encoding";
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

describe("verify_lock_log vectors", () => {
  it.each(committed.verify_lock_log.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const result = await verifyLockLog(vector.entries, {
        orgId: vector.org_id,
      });
      if (vector.expect.ok) {
        expect(result).toEqual({ ok: true, state: vector.expect.state });
      } else {
        expect(result).toMatchObject({
          ok: false,
          reason: vector.expect.reason,
          index: vector.expect.index,
        });
      }
    },
  );
});

describe("verify_locked_rules vectors", () => {
  it.each(committed.verify_locked_rules.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const o = vector.options;
      const result = await verifyLockedRules(vector.envelope, {
        lock: await lockState(vector.lock),
        orgId: o.org_id,
        haveVersion: o.have_version,
        knownFormats: o.known_formats,
        knownFeatures: o.known_features,
      });
      if (vector.expect.ok) {
        expect(result).toMatchObject({
          ok: true,
          signer: { kind: "org", key_id: vector.expect.key_id },
          rules: { version: vector.expect.version },
        });
        expect(result.ok && result.signer.role).toBe(vector.expect.role);
      } else {
        expect(result).toMatchObject({
          ok: false,
          reason: vector.expect.reason,
        });
      }
    },
  );
});

describe("fingerprint vectors", () => {
  it.each(committed.fingerprint.map((v) => [v.lock_id, v] as const))(
    "%s",
    (_name, vector) => {
      expect(lockFingerprint(vector.lock_id)).toBe(vector.fingerprint);
      expect(formatFingerprint(vector.fingerprint)).toBe(vector.display);
    },
  );

  it.each(committed.same_fingerprint.map((v) => [JSON.stringify(v), v]))(
    "same_fingerprint %s",
    (_name, vector) => {
      expect(sameFingerprint(vector.a, vector.b)).toBe(vector.same);
      expect(sameFingerprint(vector.b, vector.a)).toBe(vector.same);
    },
  );
});

describe("recovery code vectors", () => {
  const { org_id, sets, cases } = committed.recovery_codes;

  it.each(Object.entries(sets))(
    "check values of set %s",
    async (_name, set) => {
      for (const [i, code] of set.codes.entries()) {
        const bytes = parseRecoveryCode(code);
        if (bytes === null) throw new Error(`bad code ${code}`);
        expect(await recoveryCheckValue(org_id, set.recovery.salt, bytes)).toBe(
          set.recovery.checks[i],
        );
      }
    },
  );

  it.each(cases.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const set = sets[vector.set];
      expect(
        await testRecoveryCode(set.recovery, vector.org_id, vector.code),
      ).toBe(vector.expect);
    },
  );
});

describe("recovery_messages vectors", () => {
  it.each(committed.recovery_messages.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const result = await checkRecoveryMessage(
        vector.message,
        await lockState(vector.lock),
      );
      expect(result).toMatchObject(vector.expect);
    },
  );
});

describe("check_signed_request vectors", () => {
  it.each(committed.check_signed_request.map((v) => [v.name, v] as const))(
    "%s",
    async (_name, vector) => {
      const c = vector.context;
      const body = fromBase64Url(vector.request.body_base64url);
      if (body === null) throw new Error("bad body");
      const access =
        vector.access.kind === "create"
          ? vector.access
          : { kind: "rig" as const, rigOwner: vector.access.rig_owner };
      const result = await checkSignedRequest(
        {
          header: vector.header,
          method: vector.request.method,
          path: vector.request.path,
          body,
          access,
        },
        {
          rules: payload(c.rules),
          orgId: c.org_id,
          hostId: c.host_id,
          now: c.now,
          processStartedAt: c.process_started_at,
          used: usedStore(c.used),
        },
      );
      if (vector.expect.ok) {
        expect(result).toMatchObject({
          ok: true,
          opIndex: vector.expect.op_index,
          signer: {
            key_id: vector.expect.key_id,
            principal: { id: vector.expect.principal_id },
            device_id: vector.expect.device_id,
          },
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

async function lockState(name: string): Promise<LockState> {
  const log = committed.lock_logs[name];
  if (log === undefined) throw new Error(`no lock log ${name}`);
  const result = await verifyLockLog(log, {
    orgId: committed.recovery_codes.org_id,
  });
  if (!result.ok) throw new Error(`lock log ${name}: ${result.detail}`);
  return result.state;
}

function usedStore(
  used: { nonce: string; index: number }[],
): UsedOperationStore {
  const keys = new Set(used.map(({ nonce, index }) => `${nonce}/${index}`));
  return {
    isUsed: (nonce, index) => keys.has(`${nonce}/${index}`),
    markUsed: () => {
      throw new Error("checkSignedRequest must not mark operations");
    },
  };
}

function payload(name: string): RulesPayload {
  const found = committed.payloads[name];
  if (found === undefined) throw new Error(`no payload ${name}`);
  return found;
}
