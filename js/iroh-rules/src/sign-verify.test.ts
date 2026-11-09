import { describe, expect, it } from "vitest";
import {
  checkPeer,
  checkTarget,
  encodePayload,
  rulesPublicKey,
  signRules,
  SUPPORTED_FEATURES,
  SUPPORTED_FORMATS,
  verifyRules,
  type RulesEnvelope,
  type RulesPayload,
  type VerifyOptions,
} from "./index";
import { fromBase64Url, toBase64Url } from "./internal/encoding";

const AMIKA_SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);

const PAYLOAD: RulesPayload = {
  format: 1,
  required_features: [],
  org_id: "org_1",
  version: 5,
  issued_at: 1794200000000,
  principals: [{ kind: "user", id: "user_1", role: "admin" }],
  devices: [
    {
      device_id: "dev_0123456789abcdefghijklmnop",
      endpoint_id: "ab".repeat(32),
      principal: { kind: "user", id: "user_1" },
    },
  ],
  roles: { admin: { rigs: "all", ports: "all" } },
  services: [
    { service: "dialer", endpoint_id: "cd".repeat(32), targets: ["hostd"] },
  ],
};

async function options(over: Partial<VerifyOptions> = {}) {
  return {
    trustedKeys: [await rulesPublicKey(AMIKA_SEED)],
    trustedKinds: ["amika"],
    orgId: "org_1",
    haveVersion: null,
    knownFormats: SUPPORTED_FORMATS,
    knownFeatures: SUPPORTED_FEATURES,
    ...over,
  };
}

function sign(bytes: Uint8Array, privateKey = AMIKA_SEED, kind = "amika") {
  return signRules(bytes, { kind, privateKey });
}

const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("signRules and verifyRules", () => {
  it("round-trips a payload", async () => {
    const envelope = await sign(encodePayload(PAYLOAD));
    const result = await verifyRules(envelope, await options());
    expect(result).toEqual({
      ok: true,
      rules: PAYLOAD,
      signer: { kind: "amika", key_id: await rulesPublicKey(AMIKA_SEED) },
    });
  });

  it("verifies an envelope that went through JSON", async () => {
    const envelope = await sign(encodePayload(PAYLOAD));
    const wire = JSON.parse(JSON.stringify(envelope)) as unknown;
    expect(await verifyRules(wire, await options())).toMatchObject({
      ok: true,
    });
  });

  it("signs the context, a zero byte and the payload bytes", async () => {
    const bytes = encodePayload(PAYLOAD);
    const envelope = await sign(bytes);
    const [signature] = envelope.signatures;
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(signature.key_id, "hex"),
      "Ed25519",
      false,
      ["verify"],
    );
    const sig = fromBase64Url(signature.sig)!;
    const message = Buffer.concat([
      Buffer.from("amika-iroh-rules-v1\0"),
      bytes,
    ]);
    expect(await crypto.subtle.verify("Ed25519", key, sig, message)).toBe(true);
    expect(await crypto.subtle.verify("Ed25519", key, sig, bytes)).toBe(false);
  });

  it("carries the signer's principal and device id", async () => {
    const envelope = await signRules(encodePayload(PAYLOAD), {
      kind: "org",
      privateKey: AMIKA_SEED,
      principal: { kind: "user", id: "user_1" },
      device_id: "dev_0123456789abcdefghijklmnop",
    });
    const result = await verifyRules(
      envelope,
      await options({ trustedKinds: ["org"] }),
    );
    expect(result).toMatchObject({
      ok: true,
      signer: {
        kind: "org",
        principal: { kind: "user", id: "user_1" },
        device_id: "dev_0123456789abcdefghijklmnop",
      },
    });
  });

  it("refuses any one changed payload byte", async () => {
    const bytes = encodePayload(PAYLOAD);
    const envelope = await sign(bytes);
    const opts = await options();
    for (let i = 0; i < bytes.length; i++) {
      const changed = bytes.slice();
      changed[i] ^= 0x20;
      const result = await verifyRules(
        { ...envelope, payload: toBase64Url(changed) },
        opts,
      );
      expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
    }
  });

  it("accepts when a trusted signature follows an untrusted one", async () => {
    const bytes = encodePayload(PAYLOAD);
    const trusted = await sign(bytes);
    const untrusted = await sign(bytes, OTHER_SEED);
    const envelope: RulesEnvelope = {
      payload: trusted.payload,
      signatures: [...untrusted.signatures, ...trusted.signatures],
    };
    expect(await verifyRules(envelope, await options())).toMatchObject({
      ok: true,
      signer: { key_id: await rulesPublicKey(AMIKA_SEED) },
    });
  });

  it("drops unknown optional fields", async () => {
    const extended = {
      ...PAYLOAD,
      future: { nested: true },
      roles: { admin: { rigs: "all", ports: "all", future: 1 } },
    };
    const result = await verifyRules(
      await sign(json(extended)),
      await options(),
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: true, rules: PAYLOAD }),
    );
  });

  describe("refusals", () => {
    const cases: [
      string,
      (bytes: Uint8Array) => Promise<unknown>,
      Partial<VerifyOptions>,
      string,
    ][] = [
      [
        "bad signature",
        async (b) => tamperSig(await sign(b)),
        {},
        "bad_signature",
      ],
      ["untrusted key", (b) => sign(b, OTHER_SEED), {}, "untrusted_key"],
      [
        "untrusted kind",
        (b) => sign(b, AMIKA_SEED, "org"),
        {},
        "untrusted_kind",
      ],
      [
        "unknown format",
        () => sign(json({ ...PAYLOAD, format: 2 })),
        {},
        "unknown_format",
      ],
      [
        "unknown required feature",
        () => sign(json({ ...PAYLOAD, required_features: ["x"] })),
        {},
        "unknown_feature",
      ],
      ["wrong org", (b) => sign(b), { orgId: "org_2" }, "wrong_org"],
      ["same version", (b) => sign(b), { haveVersion: 5 }, "old_version"],
      ["older version", (b) => sign(b), { haveVersion: 6 }, "old_version"],
      [
        "malformed payload",
        () => sign(json({ ...PAYLOAD, version: -1 })),
        {},
        "malformed",
      ],
      ["malformed envelope", async () => ({ payload: 1 }), {}, "malformed"],
    ];

    it.each(cases)("%s", async (_name, make, over, reason) => {
      const envelope = await make(encodePayload(PAYLOAD));
      expect(await verifyRules(envelope, await options(over))).toMatchObject({
        ok: false,
        reason,
      });
    });
  });

  it("accepts a version above the host's", async () => {
    const envelope = await sign(encodePayload(PAYLOAD));
    expect(
      await verifyRules(envelope, await options({ haveVersion: 4 })),
    ).toMatchObject({ ok: true });
  });
});

describe("encodePayload", () => {
  it("refuses a payload that breaks the format", () => {
    const bad = {
      ...PAYLOAD,
      roles: { admin: { rigs: "some", ports: "all" } },
    };
    expect(() => encodePayload(bad as unknown as RulesPayload)).toThrow();
  });
});

describe("signRules", () => {
  it("refuses a key that is not a 32-byte seed", async () => {
    await expect(
      signRules(encodePayload(PAYLOAD), {
        kind: "amika",
        privateKey: new Uint8Array(64),
      }),
    ).rejects.toThrow(/32-byte/);
  });
});

describe("role names", () => {
  it("never finds a role through the object prototype", () => {
    const rules: RulesPayload = {
      ...PAYLOAD,
      principals: [{ kind: "user", id: "user_1", role: "toString" }],
    };
    const peer = checkPeer(rules, "ab".repeat(32));
    if (!peer.allowed) throw new Error("device missing");
    expect(
      checkTarget(rules, peer, { kind: "rig", rigId: "r", port: 22 }, null),
    ).toEqual({ allowed: false, reason: "not_allowed" });
  });
});

function tamperSig(envelope: RulesEnvelope): RulesEnvelope {
  const sig = fromBase64Url(envelope.signatures[0].sig)!;
  sig[5] ^= 0x01;
  return {
    ...envelope,
    signatures: [{ ...envelope.signatures[0], sig: toBase64Url(sig) }],
  };
}
