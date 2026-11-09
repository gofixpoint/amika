import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendLockEntries,
  checkSignedRequest,
  encodeLockEntry,
  encodeRequestPayload,
  encodeSignedRequestHeader,
  formatFingerprint,
  lockFingerprint,
  makeRecoveryCodes,
  rulesPublicKey,
  signLockEntry,
  signRequest,
  bodySha256,
  SUPPORTED_FEATURES,
  testRecoveryCode,
  verifyLockLog,
  type LockEntryPayload,
  type SignedRequestPayload,
  type UsedOperationStore,
} from "./index";
import { fromBase32, fromBase64Url, toBase32 } from "./internal/encoding";
import type { TestVectors } from "./testing/build-test-vectors";

const vectors = JSON.parse(
  readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8"),
) as TestVectors;

const ORG = "org_vectors";
const key = (name: keyof TestVectors["lock_keys"]) =>
  vectors.lock_keys[name].public_hex;
const seedOf = (name: keyof TestVectors["lock_keys"]) =>
  Uint8Array.from(Buffer.from(vectors.lock_keys[name].seed_hex, "hex"));

describe("verifyLockLog", () => {
  it("reduces the main log to the keys its entries leave", async () => {
    const result = await verifyLockLog(vectors.lock_logs.main, { orgId: ORG });
    if (!result.ok) throw new Error(result.detail);
    const { state } = result;
    expect(state.seq).toBe(6);
    expect(state.root_keys.map((k) => k.key_id)).toEqual([
      key("root_1"),
      key("root_3"),
    ]);
    expect(state.admin_keys.map((k) => k.key_id)).toEqual([key("admin_1")]);
    expect(state.removed_keys).toEqual([key("root_2"), key("admin_2")]);
    expect(state.recovery).toEqual(vectors.recovery_codes.sets.second.recovery);
    expect(state.disabled).toBe(false);
  });

  it("names the lock by the SHA-256 of the genesis payload bytes", async () => {
    const result = await verifyLockLog(vectors.lock_logs.genesis, {
      orgId: ORG,
    });
    if (!result.ok) throw new Error(result.detail);
    const genesis = fromBase64Url(vectors.lock_logs.genesis[0].payload)!;
    const hash = await crypto.subtle.digest("SHA-256", genesis);
    expect(result.state.lock_id).toBe(Buffer.from(hash).toString("hex"));
    expect(result.state.head).toBe(result.state.lock_id);
  });

  it("gives the same state entry by entry as all at once", async () => {
    const log = vectors.lock_logs.disabled;
    const whole = await verifyLockLog(log, { orgId: ORG });
    let step = await verifyLockLog(log.slice(0, 1), { orgId: ORG });
    for (const entry of log.slice(1)) {
      if (!step.ok) throw new Error(step.detail);
      const before = structuredClone(step.state);
      const next = await appendLockEntries(step.state, [entry], {
        orgId: ORG,
      });
      expect(step.state).toEqual(before);
      step = next;
    }
    expect(step).toEqual(whole);
  });

  it("reports the index within the appended entries", async () => {
    const start = await verifyLockLog(vectors.lock_logs.main.slice(0, 2), {
      orgId: ORG,
    });
    if (!start.ok) throw new Error(start.detail);
    const result = await appendLockEntries(
      start.state,
      [vectors.lock_logs.main[2], vectors.lock_logs.main[4]],
      { orgId: ORG },
    );
    expect(result).toMatchObject({ ok: false, reason: "bad_seq", index: 1 });
  });
});

describe("encodeLockEntry and signLockEntry", () => {
  const genesis: LockEntryPayload = {
    format: 1,
    required_features: [],
    org_id: ORG,
    seq: 0,
    issued_at: 1794200000000,
    op: "genesis",
    root_keys: [{ key_id: "11".repeat(32), name: "safe-1" }],
    recovery: vectors.recovery_codes.sets.first.recovery,
  };

  it("refuses a genesis with prev", () => {
    expect(() =>
      encodeLockEntry({ ...genesis, prev: "00".repeat(32) } as never),
    ).toThrow();
  });

  it("refuses an entry larger than 4 KiB", () => {
    expect(() =>
      encodeLockEntry({
        ...genesis,
        root_keys: [{ key_id: "11".repeat(32), name: "x".repeat(4096) }],
      }),
    ).toThrow(/4096/);
  });

  it("signs the lock domain, a zero byte and the payload bytes", async () => {
    const bytes = encodeLockEntry(genesis);
    const envelope = await signLockEntry(bytes, [seedOf("root_1")]);
    const [signature] = envelope.signatures;
    expect(signature).toMatchObject({ kind: "org", key_id: key("root_1") });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(signature.key_id, "hex"),
      "Ed25519",
      false,
      ["verify"],
    );
    const message = Buffer.concat([Buffer.from("amika-iroh-lock-v1\0"), bytes]);
    const sig = fromBase64Url(signature.sig)!;
    expect(await crypto.subtle.verify("Ed25519", publicKey, sig, message)).toBe(
      true,
    );
  });
});

describe("base32", () => {
  it.each([
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ])("encodes RFC 4648's %j", (text, encoded) => {
    const bytes = new TextEncoder().encode(text);
    expect(toBase32(bytes)).toBe(encoded);
    expect(fromBase32(encoded)).toEqual(bytes);
  });

  it.each(["MZXQ", "mzxq=", "m", "mzx", "mzxw6y", "mz", "mzxr"])(
    "refuses %j",
    (text) => {
      expect(fromBase32(text)).toBeNull();
    },
  );
});

describe("lockFingerprint", () => {
  it("is 32 base32 characters, shown in 8 groups of 4", () => {
    const fingerprint = lockFingerprint("ab".repeat(32));
    expect(fingerprint).toMatch(/^[a-z2-7]{32}$/);
    expect(formatFingerprint(fingerprint)).toMatch(
      /^([a-z2-7]{4}-){7}[a-z2-7]{4}$/,
    );
  });

  it("throws on a value that is not a lock id", () => {
    expect(() => lockFingerprint("AB".repeat(32))).toThrow();
  });
});

describe("makeRecoveryCodes", () => {
  it("makes five codes that each pass, for this org only", async () => {
    const { codes, recovery } = await makeRecoveryCodes(ORG);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    expect(fromBase64Url(recovery.salt)).toHaveLength(16);
    for (const code of codes) {
      expect(code).toMatch(/^([a-z2-7]{4}-){7}[a-z2-7]{4}$/);
      expect(await testRecoveryCode(recovery, ORG, code)).toBe(true);
      expect(await testRecoveryCode(recovery, "org_other", code)).toBe(false);
    }
  });
});

describe("signed requests", () => {
  const T0 = 1794200000000;
  const body = new TextEncoder().encode('{"argv":["true"]}');
  const path = "/v0beta1/rigs/rig_abc/exec";

  async function signedHeader() {
    const payload: SignedRequestPayload = {
      format: 1,
      required_features: [],
      org_id: ORG,
      host_id: "host_vectors",
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      issued_at: T0,
      expires_at: T0 + 60_000,
      ops: [{ method: "POST", path, body_sha256: await bodySha256(body) }],
    };
    return encodeSignedRequestHeader(
      await signRequest(encodeRequestPayload(payload), {
        privateKey: seedOf("member_device"),
        principal: { kind: "user", id: "user_member" },
        device_id: "dev_01JMEMBERLAPTOP00000000000",
      }),
    );
  }

  it("refuses an operation after the store marks it used", async () => {
    const used = new Map<string, number>();
    const store: UsedOperationStore = {
      isUsed: (nonce, index) => used.has(`${nonce}/${index}`),
      markUsed: (nonce, index, expiresAt) => {
        if (used.has(`${nonce}/${index}`)) return false;
        used.set(`${nonce}/${index}`, expiresAt);
        return true;
      },
    };
    const input = {
      header: await signedHeader(),
      method: "POST",
      path,
      body,
      access: {
        kind: "rig" as const,
        rigOwner: { kind: "user" as const, id: "user_member" },
      },
    };
    const context = {
      rules: vectors.payloads.locked,
      orgId: ORG,
      hostId: "host_vectors",
      now: T0 + 1000,
      processStartedAt: T0 - 1000,
      used: store,
    };
    const first = await checkSignedRequest(input, context);
    if (!first.ok) throw new Error(first.detail);
    expect(first.signer.key_id).toBe(
      await rulesPublicKey(seedOf("member_device")),
    );
    expect(store.markUsed(first.nonce, first.opIndex, first.expiresAt)).toBe(
      true,
    );
    expect(await checkSignedRequest(input, context)).toMatchObject({
      ok: false,
      reason: "replayed",
    });
  });

  it("will not encode a payload that hosts refuse", async () => {
    const payload: SignedRequestPayload = {
      format: 1,
      required_features: [],
      org_id: ORG,
      host_id: "host_vectors",
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      issued_at: T0,
      expires_at: T0 + 30 * 60_000 + 1,
      ops: [{ method: "POST", path, body_sha256: await bodySha256(body) }],
    };
    expect(() => encodeRequestPayload(payload)).toThrow(/30 minutes/);
    expect(() =>
      encodeRequestPayload({ ...payload, expires_at: T0 + 1, ops: [] }),
    ).toThrow();
  });
});

describe("phase 1 hosts", () => {
  it("do not know lock_v1, so they refuse records that need it", () => {
    expect(SUPPORTED_FEATURES).not.toContain("lock_v1");
  });
});
