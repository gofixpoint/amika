/**
 * The locked org (phase 1b) part of `test-vectors.json`: lock logs, rules
 * that lock keys sign, fingerprints, recovery codes and signed requests.
 * `build-test-vectors.ts` merges it into the file. Ed25519 is
 * deterministic and every salt, code and nonce is fixed, so the output is
 * stable.
 */
import { fromBase64Url, fromHex, toBase64Url } from "../internal/encoding";
import {
  encodeLockEntry,
  formatFingerprint,
  lockEntryHash,
  lockFingerprint,
  signLockEntry,
  type LockEntryEnvelope,
  type LockEntryPayload,
  type LockState,
  type RecoveryData,
} from "../internal/lock";
import { verifyLockLog } from "../internal/lock-verify";
import { formatRecoveryCode, recoveryCheckValue } from "../internal/recovery";
import {
  bodySha256,
  encodeRequestPayload,
  encodeSignedRequestHeader,
  signRequest,
  type RequestOperation,
  type SignedRequestEnvelope,
  type SignedRequestPayload,
} from "../internal/request";
import type { Principal, RulesPayload } from "../internal/rules";
import { encodePayload, rulesPublicKey, signRules } from "../internal/sign";

export interface LockVectors {
  lock_keys: Record<LockKeyName, { seed_hex: string; public_hex: string }>;
  lock_logs: Record<string, LockEntryEnvelope[]>;
  verify_lock_log: VerifyLockLogVector[];
  verify_locked_rules: VerifyLockedRulesVector[];
  fingerprint: FingerprintVector[];
  same_fingerprint: { a: string; b: string; same: boolean }[];
  recovery_codes: RecoveryCodesVector;
  recovery_messages: RecoveryMessageVector[];
  check_signed_request: SignedRequestVector[];
}

export interface VerifyLockLogVector {
  name: string;
  org_id: string;
  entries: unknown;
  expect:
    | { ok: true; state: LockState }
    | { ok: false; reason: string; index: number };
}

export interface VerifyLockedRulesVector {
  name: string;
  /** A key of `lock_logs`. Verify that log to get the host's lock state. */
  lock: string;
  envelope: unknown;
  options: {
    org_id: string;
    have_version: number | null;
    known_formats: number[];
    known_features: string[];
  };
  expect:
    | {
        ok: true;
        key_id: string;
        role: "root" | "admin";
        version: number;
      }
    | { ok: false; reason: string };
}

export interface FingerprintVector {
  lock_id: string;
  fingerprint: string;
  display: string;
}

export interface RecoveryCodesVector {
  org_id: string;
  sets: Record<string, { recovery: RecoveryData; codes: string[] }>;
  cases: {
    name: string;
    set: string;
    org_id: string;
    code: string;
    expect: boolean;
  }[];
}

export interface RecoveryMessageVector {
  name: string;
  lock: string;
  message: unknown;
  expect: { ok: true } | { ok: false; reason: string };
}

export interface SignedRequestVector {
  name: string;
  header: string | null;
  request: { method: string; path: string; body_base64url: string };
  access:
    | { kind: "create"; owner: Principal | null }
    | { kind: "rig"; rig_owner: Principal | null };
  context: {
    rules: string;
    org_id: string;
    host_id: string;
    now: number;
    process_started_at: number;
    used: { nonce: string; index: number }[];
  };
  expect:
    | {
        ok: true;
        op_index: number;
        key_id: string;
        principal_id: string;
        device_id: string;
      }
    | { ok: false; reason: string };
}

type LockKeyName =
  | "amika"
  | "root_1"
  | "root_2"
  | "root_3"
  | "root_4"
  | "root_5"
  | "admin_1"
  | "admin_2"
  | "member_device"
  | "stranger";

/**
 * Test-only seeds. `amika` is RFC 8032's test 1 key, as in the phase 1
 * vectors. The rest are fixed byte patterns. Never trust them.
 */
const SEEDS: Record<LockKeyName, string> = {
  amika: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  root_1: "11".repeat(32),
  root_2: "22".repeat(32),
  root_3: "33".repeat(32),
  root_4: "44".repeat(32),
  root_5: "55".repeat(32),
  admin_1: "a1".repeat(32),
  admin_2: "a2".repeat(32),
  member_device: "b1".repeat(32),
  stranger: "99".repeat(32),
};

const ORG = "org_vectors";
const HOST = "host_vectors";
const T0 = 1794200000000;

const ADMIN = { kind: "user" as const, id: "user_admin" };
const MEMBER = { kind: "user" as const, id: "user_member" };
const BOB = { kind: "user" as const, id: "user_bob" };
const ADMIN_DEVICE = "dev_01JADMINLAPTOP000000000000";
const MEMBER_DEVICE = "dev_01JMEMBERLAPTOP00000000000";
const PORTS_DEVICE = "dev_01JPORTSLAPTOP000000000000";

/** Build every locked org vector. `base` is the phase 1 `base` payload. */
export async function buildLockVectors(
  base: RulesPayload,
): Promise<{ vectors: LockVectors; lockedPayload: RulesPayload }> {
  const keys = await buildKeys();
  const k = (name: LockKeyName) => keys[name].public_hex;
  const recovery = await buildRecoverySets();
  const chain = new Chain(keys);

  const genesis = await chain.genesis(
    [
      { key_id: k("root_1"), name: "safe-1" },
      { key_id: k("root_2"), name: "safe-2" },
    ],
    recovery.first.recovery,
    ["root_1", "root_2"],
  );
  const main: LockEntryEnvelope[] = [genesis.envelope];
  let head = genesis.hash;
  const append = async (
    entry: ChainedFields,
    signers: LockKeyName[],
  ): Promise<void> => {
    const made = await chain.entry(main.length, head, entry, signers);
    main.push(made.envelope);
    head = made.hash;
  };
  await append(approve("admin_1", ADMIN, ADMIN_DEVICE, k), ["root_1"]);
  await append({ op: "add_root_key", key_id: k("root_3"), name: "safe-3" }, [
    "root_1",
    "root_3",
  ]);
  await append({ op: "remove_root_key", key_id: k("root_2") }, ["root_3"]);
  await append(approve("admin_2", MEMBER, MEMBER_DEVICE, k), ["root_1"]);
  await append({ op: "revoke_key", key_id: k("admin_2") }, ["admin_1"]);
  await append({ op: "set_recovery", recovery: recovery.second.recovery }, [
    "root_1",
  ]);
  const mainHead = head;
  const disabledLog = [
    ...main,
    (await chain.entry(7, mainHead, { op: "disable" }, ["root_3"])).envelope,
  ];

  const single = await chain.genesis(
    [{ key_id: k("root_1"), name: "only" }],
    recovery.first.recovery,
    ["root_1"],
  );

  const logs = {
    genesis: [genesis.envelope],
    main,
    disabled: disabledLog,
    single_root: [single.envelope],
  };
  const states = {
    main: await stateOf(main),
    genesis: await stateOf(logs.genesis),
    disabled: await stateOf(disabledLog),
    single_root: await stateOf(logs.single_root),
  };

  const lockedPayload: RulesPayload = {
    ...base,
    required_features: ["lock_v1"],
    version: 43,
    devices: base.devices.map((device) =>
      device.device_id === ADMIN_DEVICE
        ? { ...device, signing_key: k("admin_1") }
        : device.device_id === MEMBER_DEVICE
          ? { ...device, signing_key: k("member_device") }
          : device,
    ),
    lock: { lock_id: states.main.lock_id, seq: 6 },
    amika_access: [{ rig_id: "rig-shared", allow: ["exec", "files"] }],
  };

  return {
    lockedPayload,
    vectors: {
      lock_keys: keys,
      lock_logs: logs,
      verify_lock_log: await buildVerifyLockLog(
        chain,
        logs,
        states,
        recovery,
        k,
      ),
      verify_locked_rules: await buildVerifyLockedRules(
        lockedPayload,
        states.main.lock_id,
        k,
      ),
      fingerprint: [states.main, states.single_root].map(({ lock_id }) => {
        const fingerprint = lockFingerprint(lock_id);
        return {
          lock_id,
          fingerprint,
          display: formatFingerprint(fingerprint),
        };
      }),
      same_fingerprint: sameFingerprintCases(
        lockFingerprint(states.main.lock_id),
      ),
      recovery_codes: recoveryCases(recovery),
      recovery_messages: recoveryMessages(states, recovery),
      check_signed_request: await buildSignedRequests(k),
    },
  };
}

async function buildKeys(): Promise<LockVectors["lock_keys"]> {
  const entries = await Promise.all(
    (Object.keys(SEEDS) as LockKeyName[]).map(async (name) => {
      const public_hex = await rulesPublicKey(seed(name));
      return [name, { seed_hex: SEEDS[name], public_hex }] as const;
    }),
  );
  return Object.fromEntries(entries) as LockVectors["lock_keys"];
}

function seed(name: LockKeyName): Uint8Array {
  const bytes = fromHex(SEEDS[name]);
  if (bytes === null) throw new Error(`bad seed ${name}`);
  return bytes;
}

async function stateOf(log: LockEntryEnvelope[]): Promise<LockState> {
  const result = await verifyLockLog(log, { orgId: ORG });
  if (!result.ok) throw new Error(`vector log refused: ${result.detail}`);
  return result.state;
}

type ChainedFields =
  | { op: "add_root_key"; key_id: string; name: string }
  | { op: "remove_root_key"; key_id: string }
  | {
      op: "approve_key";
      key_id: string;
      principal: Principal;
      device_id: string;
      can: ["sign_rules"];
    }
  | { op: "revoke_key"; key_id: string }
  | { op: "set_recovery"; recovery: RecoveryData }
  | { op: "disable" };

function approve(
  key: LockKeyName,
  principal: Principal,
  device_id: string,
  k: (name: LockKeyName) => string,
): ChainedFields {
  return {
    op: "approve_key",
    key_id: k(key),
    principal,
    device_id,
    can: ["sign_rules"],
  };
}

/** Makes signed lock entries. `raw*` methods skip the format checks. */
class Chain {
  constructor(private readonly keys: LockVectors["lock_keys"]) {}

  async genesis(
    root_keys: { key_id: string; name: string }[],
    recovery: RecoveryData,
    signers: LockKeyName[],
    over: Record<string, unknown> = {},
  ) {
    return this.raw(
      {
        format: 1,
        required_features: [],
        org_id: ORG,
        seq: 0,
        issued_at: T0,
        op: "genesis",
        root_keys,
        recovery,
        ...over,
      },
      signers,
    );
  }

  async entry(
    seq: number,
    prev: string,
    fields: ChainedFields,
    signers: LockKeyName[],
    over: Record<string, unknown> = {},
  ) {
    const payload = {
      format: 1,
      required_features: [],
      org_id: ORG,
      seq,
      prev,
      issued_at: T0 + seq * 1000,
      ...fields,
      ...over,
    };
    if (Object.keys(over).length === 0) {
      encodeLockEntry(payload as LockEntryPayload);
    }
    return this.raw(payload, signers);
  }

  /** Sign any JSON value as a lock entry payload. */
  async raw(payload: unknown, signers: LockKeyName[]) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return {
      bytes,
      hash: await lockEntryHash(bytes),
      envelope: await signLockEntry(bytes, signers.map(seed)),
    };
  }

  publicKey(name: LockKeyName): string {
    return this.keys[name].public_hex;
  }
}

async function buildVerifyLockLog(
  chain: Chain,
  logs: Record<
    "genesis" | "main" | "disabled" | "single_root",
    LockEntryEnvelope[]
  >,
  states: Record<"genesis" | "main" | "disabled" | "single_root", LockState>,
  recovery: RecoverySets,
  k: (name: LockKeyName) => string,
): Promise<VerifyLockLogVector[]> {
  const { main } = logs;
  const r1 = recovery.first.recovery;
  const roots2 = [
    { key_id: k("root_1"), name: "safe-1" },
    { key_id: k("root_2"), name: "safe-2" },
  ];
  /** The hash of `main[seq]`: the `prev` of an entry that follows it. */
  const hashOf = async (seq: number) => lockEntryHash(payloadBytes(main[seq]));
  const ok = (name: string, entries: unknown, state: LockState) => ({
    name,
    org_id: ORG,
    entries,
    expect: { ok: true as const, state },
  });
  const no = (
    name: string,
    entries: unknown,
    reason: string,
    index: number,
  ) => ({
    name,
    org_id: ORG,
    entries,
    expect: { ok: false as const, reason, index },
  });
  const after = async (
    seq: number,
    fields: ChainedFields,
    signers: LockKeyName[],
    over: Record<string, unknown> = {},
  ) => [
    ...main.slice(0, seq + 1),
    (await chain.entry(seq + 1, await hashOf(seq), fields, signers, over))
      .envelope,
  ];
  const fourRoots = await chain.genesis(
    (["root_1", "root_2", "root_3", "root_4"] as const).map((name) => ({
      key_id: k(name),
      name,
    })),
    r1,
    ["root_1", "root_2", "root_3", "root_4"],
  );
  const g = logs.genesis[0];
  const genesisHash = await hashOf(0);
  const withSig = (
    envelope: LockEntryEnvelope,
    index: number,
    change: (sig: { kind: string; key_id: string; sig: string }) => object,
  ) => ({
    ...envelope,
    signatures: envelope.signatures.map((s, i) =>
      i === index ? change(s) : s,
    ),
  });

  return [
    ok("genesis only", logs.genesis, states.genesis),
    ok("genesis with one root key", logs.single_root, states.single_root),
    ok(
      "approve, add and remove root keys, revoke by an admin key, set recovery",
      main,
      states.main,
    ),
    ok("log that ends with disable", logs.disabled, states.disabled),
    no("empty log", [], "malformed", 0),
    no("log is not a list", { entries: [] }, "malformed", 0),
    no(
      "genesis lacks a root key's signature",
      [{ ...g, signatures: [g.signatures[0]] }],
      "missing_signature",
      0,
    ),
    no(
      "genesis has a bad signature by a root key",
      [withSig(g, 1, (s) => ({ ...s, sig: flipSig(s.sig) }))],
      "bad_signature",
      0,
    ),
    no(
      "genesis signed only by a key it does not name",
      [(await chain.genesis(roots2.slice(0, 1), r1, ["stranger"])).envelope],
      "missing_signature",
      0,
    ),
    no(
      "genesis names five root keys",
      [
        (
          await chain.genesis(
            (["root_1", "root_2", "root_3", "root_4", "root_5"] as const).map(
              (name) => ({ key_id: k(name), name }),
            ),
            r1,
            ["root_1", "root_2", "root_3", "root_4", "root_5"],
          )
        ).envelope,
      ],
      "invalid_change",
      0,
    ),
    no(
      "genesis names one root key twice",
      [(await chain.genesis([roots2[0], roots2[0]], r1, ["root_1"])).envelope],
      "invalid_change",
      0,
    ),
    no(
      "genesis carries prev",
      [
        (
          await chain.genesis(roots2, r1, ["root_1", "root_2"], {
            prev: genesisHash,
          })
        ).envelope,
      ],
      "malformed",
      0,
    ),
    no("first entry is not a genesis", [main[1]], "bad_seq", 0),
    no(
      "genesis for another org",
      [
        (
          await chain.genesis(roots2, r1, ["root_1", "root_2"], {
            org_id: "org_other",
          })
        ).envelope,
      ],
      "wrong_org",
      0,
    ),
    no(
      "broken hash: prev is not the hash of the entry before",
      [
        g,
        (
          await chain.entry(
            1,
            "00".repeat(32),
            approve("admin_1", ADMIN, ADMIN_DEVICE, k),
            ["root_1"],
          )
        ).envelope,
      ],
      "bad_prev",
      1,
    ),
    no(
      "broken hash: entries in the wrong order",
      [main[0], main[2], main[1]],
      "bad_seq",
      1,
    ),
    no(
      "payload changed after signing",
      [
        g,
        {
          ...main[1],
          payload: toBase64Url(flip(payloadBytes(main[1]), 20)),
        },
      ],
      "bad_signature",
      1,
    ),
    no(
      "seq skips a number",
      [
        g,
        (
          await chain.entry(
            2,
            genesisHash,
            approve("admin_1", ADMIN, ADMIN_DEVICE, k),
            ["root_1"],
          )
        ).envelope,
      ],
      "bad_seq",
      1,
    ),
    no(
      "entry signed by a removed root key",
      await after(3, approve("stranger", BOB, PORTS_DEVICE, k), ["root_2"]),
      "untrusted_signer",
      4,
    ),
    no(
      "entry signed by a revoked admin key",
      await after(5, { op: "revoke_key", key_id: k("admin_1") }, ["admin_2"]),
      "untrusted_signer",
      6,
    ),
    no(
      "approval note from an untrusted key",
      [
        g,
        (
          await chain.entry(
            1,
            genesisHash,
            approve("admin_1", ADMIN, ADMIN_DEVICE, k),
            ["stranger"],
          )
        ).envelope,
      ],
      "untrusted_signer",
      1,
    ),
    no(
      "approval note signed by an admin key",
      await after(1, approve("admin_2", MEMBER, MEMBER_DEVICE, k), ["admin_1"]),
      "untrusted_signer",
      2,
    ),
    no(
      "approval note signed by a root key with kind amika",
      [
        g,
        withSig(
          (
            await chain.entry(
              1,
              genesisHash,
              approve("admin_1", ADMIN, ADMIN_DEVICE, k),
              ["root_1"],
            )
          ).envelope,
          0,
          (s) => ({ ...s, kind: "amika" }),
        ),
      ],
      "untrusted_signer",
      1,
    ),
    no(
      "approval note with an unknown can value",
      await after(0, approve("admin_1", ADMIN, ADMIN_DEVICE, k), ["root_1"], {
        can: ["sign_rules", "approve_devices"],
      }),
      "malformed",
      1,
    ),
    no(
      "approval note for a root key",
      await after(0, approve("root_2", ADMIN, ADMIN_DEVICE, k), ["root_1"]),
      "invalid_change",
      1,
    ),
    no(
      "approval note for a revoked key",
      await after(5, approve("admin_2", MEMBER, MEMBER_DEVICE, k), ["root_1"]),
      "invalid_change",
      6,
    ),
    no(
      "add_root_key without the new key's signature",
      await after(1, { op: "add_root_key", key_id: k("root_3"), name: "x" }, [
        "root_1",
      ]),
      "missing_signature",
      2,
    ),
    no(
      "add_root_key signed only by the new key",
      await after(1, { op: "add_root_key", key_id: k("root_3"), name: "x" }, [
        "root_3",
      ]),
      "untrusted_signer",
      2,
    ),
    no(
      "add a fifth root key",
      [
        fourRoots.envelope,
        (
          await chain.entry(
            1,
            fourRoots.hash,
            { op: "add_root_key", key_id: k("root_5"), name: "five" },
            ["root_1", "root_5"],
          )
        ).envelope,
      ],
      "invalid_change",
      1,
    ),
    no(
      "add a removed root key again",
      await after(3, { op: "add_root_key", key_id: k("root_2"), name: "x" }, [
        "root_1",
        "root_2",
      ]),
      "invalid_change",
      4,
    ),
    no(
      "remove_root_key signed only by the key it removes",
      await after(0, { op: "remove_root_key", key_id: k("root_2") }, [
        "root_2",
      ]),
      "untrusted_signer",
      1,
    ),
    no(
      "remove the only root key",
      [
        logs.single_root[0],
        (
          await chain.entry(
            1,
            await lockEntryHash(payloadBytes(logs.single_root[0])),
            { op: "remove_root_key", key_id: k("root_1") },
            ["root_1"],
          )
        ).envelope,
      ],
      "untrusted_signer",
      1,
    ),
    no(
      "remove a key that is not a root key",
      await after(1, { op: "remove_root_key", key_id: k("admin_1") }, [
        "root_1",
      ]),
      "invalid_change",
      2,
    ),
    no(
      "revoke a key that is not an admin key",
      await after(1, { op: "revoke_key", key_id: k("stranger") }, ["root_1"]),
      "invalid_change",
      2,
    ),
    no(
      "set_recovery signed by an admin key",
      await after(1, { op: "set_recovery", recovery: r1 }, ["admin_1"]),
      "untrusted_signer",
      2,
    ),
    no(
      "entry for another org",
      await after(0, approve("admin_1", ADMIN, ADMIN_DEVICE, k), ["root_1"], {
        org_id: "org_other",
      }),
      "wrong_org",
      1,
    ),
    no(
      "unknown op",
      await after(0, { op: "disable" }, ["root_1"], { op: "rotate_all" }),
      "unknown_op",
      1,
    ),
    no(
      "unknown format",
      await after(0, { op: "disable" }, ["root_1"], { format: 2 }),
      "unknown_format",
      1,
    ),
    no(
      "unknown required feature",
      await after(0, { op: "disable" }, ["root_1"], {
        required_features: ["quorum_v1"],
      }),
      "unknown_feature",
      1,
    ),
    no(
      "entry after disable",
      [
        ...logs.disabled,
        (
          await chain.entry(
            8,
            await lockEntryHash(payloadBytes(logs.disabled[7])),
            approve("admin_2", MEMBER, MEMBER_DEVICE, k),
            ["root_1"],
          )
        ).envelope,
      ],
      "disabled",
      8,
    ),
    no(
      "entry larger than 4 KiB",
      await after(
        0,
        { op: "add_root_key", key_id: k("root_3"), name: "x" },
        ["root_1", "root_3"],
        { name: "x".repeat(4096) },
      ),
      "too_large",
      1,
    ),
  ];
}

async function buildVerifyLockedRules(
  locked: RulesPayload,
  lockId: string,
  k: (name: LockKeyName) => string,
): Promise<VerifyLockedRulesVector[]> {
  const options = (over: Partial<VerifyLockedRulesVector["options"]> = {}) => ({
    org_id: ORG,
    have_version: 42,
    known_formats: [1],
    known_features: ["lock_v1"],
    ...over,
  });
  const bytes = encodePayload(locked);
  const text = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const byAdmin = (
    b: Uint8Array,
    key: LockKeyName = "admin_1",
    who = ADMIN,
    device = ADMIN_DEVICE,
  ) =>
    signRules(b, {
      kind: "org",
      privateKey: seed(key),
      principal: who,
      device_id: device,
    });
  const byRoot = (b: Uint8Array, key: LockKeyName = "root_1") =>
    signRules(b, { kind: "org", privateKey: seed(key) });
  const admin = await byAdmin(bytes);
  const ok = (key: LockKeyName, role: "root" | "admin", version = 43) =>
    ({ ok: true, key_id: k(key), role, version }) as const;
  const no = (reason: string) => ({ ok: false, reason }) as const;
  const vector = (
    name: string,
    envelope: unknown,
    expect: VerifyLockedRulesVector["expect"],
    over: Partial<VerifyLockedRulesVector["options"]> = {},
    lock = "main",
  ): VerifyLockedRulesVector => ({
    name,
    lock,
    envelope,
    options: options(over),
    expect,
  });

  return [
    vector("signed by an approved admin key", admin, ok("admin_1", "admin")),
    vector("signed by a root key", await byRoot(bytes), ok("root_1", "root")),
    vector(
      "names an older lock seq than the host's",
      await byAdmin(text({ ...locked, lock: { lock_id: lockId, seq: 1 } })),
      ok("admin_1", "admin"),
    ),
    vector(
      "untrusted signature first, admin key second",
      {
        payload: admin.payload,
        signatures: [
          ...(await byRoot(bytes, "stranger")).signatures,
          ...admin.signatures,
        ],
      },
      ok("admin_1", "admin"),
    ),
    vector(
      "lock_v1 is known even when known_features leaves it out",
      admin,
      ok("admin_1", "admin"),
      { known_features: [] },
    ),
    vector(
      "signed by Amika's key, kind amika",
      await signRules(bytes, { kind: "amika", privateKey: seed("amika") }),
      no("untrusted_signer"),
    ),
    vector(
      "signed by Amika's key, kind org",
      await signRules(bytes, { kind: "org", privateKey: seed("amika") }),
      no("untrusted_signer"),
    ),
    vector(
      "signed by a key that is not a lock key",
      await byRoot(bytes, "stranger"),
      no("untrusted_signer"),
    ),
    vector(
      "signed by a revoked admin key, with its approval note's fields",
      await byAdmin(bytes, "admin_2", MEMBER, MEMBER_DEVICE),
      no("untrusted_signer"),
    ),
    vector(
      "signed by a removed root key",
      await byRoot(bytes, "root_2"),
      no("untrusted_signer"),
    ),
    vector(
      "admin key with another principal than its approval note",
      await byAdmin(bytes, "admin_1", MEMBER, ADMIN_DEVICE),
      no("untrusted_signer"),
    ),
    vector(
      "admin key with another device id than its approval note",
      await byAdmin(bytes, "admin_1", ADMIN, MEMBER_DEVICE),
      no("untrusted_signer"),
    ),
    vector(
      "admin key without principal and device id",
      await signRules(bytes, { kind: "org", privateKey: seed("admin_1") }),
      no("untrusted_signer"),
    ),
    vector(
      "root key with a principal and device id",
      await signRules(bytes, {
        kind: "org",
        privateKey: seed("root_1"),
        principal: ADMIN,
        device_id: ADMIN_DEVICE,
      }),
      no("untrusted_signer"),
    ),
    vector(
      "admin key signature over another payload",
      {
        payload: admin.payload,
        signatures: (await byAdmin(text({ ...locked, version: 44 })))
          .signatures,
      },
      no("bad_signature"),
    ),
    vector(
      "record without lock_v1 in required_features",
      await byAdmin(text({ ...locked, required_features: [] })),
      no("missing_lock_feature"),
    ),
    vector(
      "record for another lock",
      await byAdmin(
        text({ ...locked, lock: { lock_id: "00".repeat(32), seq: 6 } }),
      ),
      no("wrong_lock"),
    ),
    vector(
      "record without a lock field",
      await byAdmin(text({ ...locked, lock: undefined })),
      no("wrong_lock"),
    ),
    vector(
      "record names a lock seq the host does not have",
      await byAdmin(text({ ...locked, lock: { lock_id: lockId, seq: 7 } })),
      no("lock_behind"),
    ),
    vector("same version as the host's", admin, no("old_version"), {
      have_version: 43,
    }),
    vector("record for another org", admin, no("wrong_org"), {
      org_id: "org_other",
    }),
    vector(
      "required feature the host does not know",
      await byAdmin(
        text({ ...locked, required_features: ["lock_v1", "lock_v2"] }),
      ),
      no("unknown_feature"),
    ),
    vector(
      "the host's lock is off",
      await byRoot(bytes, "root_3"),
      no("untrusted_signer"),
      {},
      "disabled",
    ),
  ];
}

const sameFingerprintCases = (fingerprint: string) => [
  { a: fingerprint, b: fingerprint, same: true },
  { a: formatFingerprint(fingerprint), b: fingerprint, same: true },
  {
    a: formatFingerprint(fingerprint).toUpperCase(),
    b: formatFingerprint(fingerprint).replace(/-/g, " "),
    same: true,
  },
  { a: fingerprint, b: `${fingerprint.slice(0, 31)}a`, same: false },
  { a: fingerprint, b: fingerprint.slice(0, 28), same: false },
  { a: "", b: "", same: false },
];

interface RecoverySets {
  first: { recovery: RecoveryData; codes: string[] };
  second: { recovery: RecoveryData; codes: string[] };
}

/** Two fixed sets of five codes: the genesis's and `set_recovery`'s. */
async function buildRecoverySets(): Promise<RecoverySets> {
  const set = async (offset: number) => {
    const salt = toBase64Url(
      new Uint8Array(16).map((_, i) => (offset + i) & 0xff),
    );
    const codes: string[] = [];
    const checks: string[] = [];
    for (let c = 0; c < 5; c++) {
      const code = new Uint8Array(20).map(
        (_, i) => (offset * 7 + c * 31 + i * 13) & 0xff,
      );
      codes.push(formatRecoveryCode(code));
      checks.push(await recoveryCheckValue(ORG, salt, code));
    }
    return { recovery: { salt, checks }, codes };
  };
  return { first: await set(0), second: await set(16) };
}

function recoveryCases(sets: RecoverySets): RecoveryCodesVector {
  const [code] = sets.first.codes;
  const changed = `${code.slice(0, -1)}${code.endsWith("a") ? "b" : "a"}`;
  const c = (
    name: string,
    codeText: string,
    expect: boolean,
    org_id = ORG,
    set = "first",
  ) => ({ name, set, org_id, code: codeText, expect });
  return {
    org_id: ORG,
    sets: { first: sets.first, second: sets.second },
    cases: [
      c("first code", code, true),
      c("last code", sets.first.codes[4], true),
      c("uppercase with spaces", code.toUpperCase().replace(/-/g, " "), true),
      c("without dashes", code.replace(/-/g, ""), true),
      c("one character changed", changed, false),
      c("right code, another org", code, false, "org_other"),
      c("code of the replaced set", code, false, ORG, "second"),
      c("code of the new set", sets.second.codes[2], true, ORG, "second"),
      c("too short", code.slice(0, -4), false),
      c("too long", `${code}-aaaa`, false),
      c("not base32", code.replace(/^./, "1"), false),
      c("empty", "", false),
    ],
  };
}

function recoveryMessages(
  states: Record<"genesis" | "main", LockState>,
  sets: RecoverySets,
): RecoveryMessageVector[] {
  const msg = (lockId: string, code: string, org_id = ORG) => ({
    type: "recover",
    org_id,
    lock_id: lockId,
    code,
  });
  const main = states.main.lock_id;
  return [
    {
      name: "right code for the genesis's set",
      lock: "genesis",
      message: msg(states.genesis.lock_id, sets.first.codes[1]),
      expect: { ok: true },
    },
    {
      name: "right code after set_recovery",
      lock: "main",
      message: msg(main, sets.second.codes[3]),
      expect: { ok: true },
    },
    {
      name: "code that set_recovery replaced",
      lock: "main",
      message: msg(main, sets.first.codes[1]),
      expect: { ok: false, reason: "wrong_code" },
    },
    {
      name: "wrong code",
      lock: "main",
      message: msg(main, formatRecoveryCode(new Uint8Array(20))),
      expect: { ok: false, reason: "wrong_code" },
    },
    {
      name: "another lock id",
      lock: "main",
      message: msg("00".repeat(32), sets.second.codes[3]),
      expect: { ok: false, reason: "wrong_lock" },
    },
    {
      name: "another org",
      lock: "main",
      message: msg(main, sets.second.codes[3], "org_other"),
      expect: { ok: false, reason: "wrong_org" },
    },
    {
      name: "not a recover message",
      lock: "main",
      message: { type: "hello", org_id: ORG, lock_id: main },
      expect: { ok: false, reason: "malformed" },
    },
  ];
}

async function buildSignedRequests(
  k: (name: LockKeyName) => string,
): Promise<SignedRequestVector[]> {
  const enc = (text: string) => new TextEncoder().encode(text);
  const createBody = enc(
    JSON.stringify({ name: "rig_abc", owner: MEMBER, image: "base" }),
  );
  const createForBob = enc(JSON.stringify({ name: "rig_bob", owner: BOB }));
  const execBody = enc(JSON.stringify({ argv: ["git", "status"] }));
  const fileBody = enc("[user]\n\tname = Member\n");
  const execPath = "/v0beta1/rigs/rig_abc/exec";
  const filePath = "/v0beta1/rigs/rig_abc/files/home/amika/.gitconfig";
  const ops: RequestOperation[] = [
    {
      method: "POST",
      path: "/v0beta1/rigs",
      body_sha256: await bodySha256(createBody),
    },
    { method: "POST", path: execPath, body_sha256: await bodySha256(execBody) },
    { method: "PUT", path: filePath, body_sha256: await bodySha256(fileBody) },
    { method: "POST", path: execPath, body_sha256: await bodySha256(execBody) },
    {
      method: "POST",
      path: "/v0beta1/rigs",
      body_sha256: await bodySha256(createForBob),
    },
  ];
  const nonce = toBase64Url(new Uint8Array(16).map((_, i) => i + 1));
  const payload: SignedRequestPayload = {
    format: 1,
    required_features: [],
    org_id: ORG,
    host_id: HOST,
    nonce,
    issued_at: T0,
    expires_at: T0 + 30 * 60 * 1000,
    ops,
  };
  const member = {
    privateKey: seed("member_device"),
    principal: MEMBER,
    device_id: MEMBER_DEVICE,
  };
  const adminSigner = {
    privateKey: seed("admin_1"),
    principal: ADMIN,
    device_id: ADMIN_DEVICE,
  };
  const header = (envelope: SignedRequestEnvelope) =>
    encodeSignedRequestHeader(envelope);
  const signed = await signRequest(encodeRequestPayload(payload), member);
  const good = header(signed);
  const rawSigned = async (value: unknown, signer = member) =>
    header(await signRequest(enc(JSON.stringify(value)), signer));

  const create = { method: "POST", path: "/v0beta1/rigs", body: createBody };
  const exec = { method: "POST", path: execPath, body: execBody };
  const file = { method: "PUT", path: filePath, body: fileBody };
  const createAccess = (owner: Principal | null) => ({
    kind: "create" as const,
    owner,
  });
  const rigAccess = (owner: Principal | null) => ({
    kind: "rig" as const,
    rig_owner: owner,
  });

  type Req = { method: string; path: string; body: Uint8Array };
  const vector = (
    name: string,
    headerValue: string | null,
    req: Req,
    access: SignedRequestVector["access"],
    expect: SignedRequestVector["expect"],
    context: Partial<SignedRequestVector["context"]> = {},
  ): SignedRequestVector => ({
    name,
    header: headerValue,
    request: {
      method: req.method,
      path: req.path,
      body_base64url: toBase64Url(req.body),
    },
    access,
    context: {
      rules: "locked",
      org_id: ORG,
      host_id: HOST,
      now: T0 + 5000,
      process_started_at: T0 - 3_600_000,
      used: [],
      ...context,
    },
    expect,
  });
  const accepted = (op_index: number, by: "member" | "admin" = "member") => ({
    ok: true as const,
    op_index,
    key_id: by === "member" ? k("member_device") : k("admin_1"),
    principal_id: by === "member" ? MEMBER.id : ADMIN.id,
    device_id: by === "member" ? MEMBER_DEVICE : ADMIN_DEVICE,
  });
  const no = (reason: string) => ({ ok: false as const, reason });
  const used = (...indexes: number[]) => ({
    used: indexes.map((index) => ({ nonce, index })),
  });
  const sigChanged = header({
    ...signed,
    signatures: [
      { ...signed.signatures[0], sig: flipSig(signed.signatures[0].sig) },
    ],
  });

  return [
    vector(
      "create by the owner",
      good,
      create,
      createAccess(MEMBER),
      accepted(0),
    ),
    vector(
      "exec on the signer's own rig",
      good,
      exec,
      rigAccess(MEMBER),
      accepted(1),
    ),
    vector(
      "file write on the signer's own rig",
      good,
      file,
      rigAccess(MEMBER),
      accepted(2),
    ),
    vector(
      "second listed copy of a used operation",
      good,
      exec,
      rigAccess(MEMBER),
      accepted(3),
      used(1),
    ),
    vector(
      "issued_at 60 s ahead of the host's clock",
      good,
      exec,
      rigAccess(MEMBER),
      accepted(1),
      { now: T0 - 60_000 },
    ),
    vector(
      "admin creates a rig for another owner",
      header(await signRequest(encodeRequestPayload(payload), adminSigner)),
      { method: "POST", path: "/v0beta1/rigs", body: createForBob },
      createAccess(BOB),
      accepted(4, "admin"),
    ),
    vector(
      "no header",
      null,
      exec,
      rigAccess(MEMBER),
      no("signature_required"),
    ),
    vector(
      "header is not an envelope",
      "bm90LWpzb24",
      exec,
      rigAccess(MEMBER),
      no("bad_signature"),
    ),
    vector(
      "signature bytes changed",
      sigChanged,
      exec,
      rigAccess(MEMBER),
      no("bad_signature"),
    ),
    vector(
      "payload changed after signing",
      header({
        ...signed,
        payload: toBase64Url(
          flip(fromBase64Url(signed.payload) ?? new Uint8Array(), 30),
        ),
      }),
      exec,
      rigAccess(MEMBER),
      no("bad_signature"),
    ),
    vector(
      "header larger than 16 KiB",
      `${good}${"A".repeat(16 * 1024)}`,
      exec,
      rigAccess(MEMBER),
      no("bad_signature"),
    ),
    vector(
      "signer is not an approved device key",
      header(
        await signRequest(encodeRequestPayload(payload), {
          ...member,
          privateKey: seed("stranger"),
        }),
      ),
      exec,
      rigAccess(MEMBER),
      no("unknown_signer"),
    ),
    vector(
      "signer's device has no signing key in the rules",
      header(
        await signRequest(encodeRequestPayload(payload), {
          privateKey: seed("stranger"),
          principal: { kind: "user", id: "user_ports" },
          device_id: PORTS_DEVICE,
        }),
      ),
      exec,
      rigAccess(MEMBER),
      no("unknown_signer"),
    ),
    vector(
      "signature names another principal than the device's",
      header(
        await signRequest(encodeRequestPayload(payload), {
          ...member,
          principal: ADMIN,
        }),
      ),
      exec,
      rigAccess(MEMBER),
      no("unknown_signer"),
    ),
    vector(
      "signature kind is not device",
      header({
        ...signed,
        signatures: [{ ...signed.signatures[0], kind: "org" }],
      }),
      exec,
      rigAccess(MEMBER),
      no("unknown_signer"),
    ),
    vector(
      "signed for another host",
      await rawSigned({ ...payload, host_id: "host_other" }),
      exec,
      rigAccess(MEMBER),
      no("wrong_target"),
    ),
    vector(
      "signed for another org",
      await rawSigned({ ...payload, org_id: "org_other" }),
      exec,
      rigAccess(MEMBER),
      no("wrong_target"),
    ),
    vector(
      "unknown required feature",
      await rawSigned({ ...payload, required_features: ["batch_v2"] }),
      exec,
      rigAccess(MEMBER),
      no("wrong_target"),
    ),
    vector(
      "more than 64 operations",
      await rawSigned({
        ...payload,
        ops: Array.from({ length: 65 }, () => ops[1]),
      }),
      exec,
      rigAccess(MEMBER),
      no("wrong_target"),
    ),
    vector("expired", good, exec, rigAccess(MEMBER), no("expired"), {
      now: payload.expires_at,
    }),
    vector(
      "issued_at more than 60 s ahead of the host's clock",
      good,
      exec,
      rigAccess(MEMBER),
      no("expired"),
      { now: T0 - 60_001 },
    ),
    vector(
      "issued before this hostd process started",
      good,
      exec,
      rigAccess(MEMBER),
      no("expired"),
      { process_started_at: T0 + 1 },
    ),
    vector(
      "lifetime longer than 30 minutes",
      await rawSigned({ ...payload, expires_at: T0 + 30 * 60 * 1000 + 1 }),
      exec,
      rigAccess(MEMBER),
      no("expired"),
    ),
    vector(
      "changed body",
      good,
      { ...exec, body: enc(JSON.stringify({ argv: ["rm", "-rf", "/"] })) },
      rigAccess(MEMBER),
      no("no_matching_op"),
    ),
    vector(
      "operation that is not listed",
      good,
      { ...exec, path: "/v0beta1/rigs/rig_other/exec" },
      rigAccess(MEMBER),
      no("no_matching_op"),
    ),
    vector(
      "listed path with another method",
      good,
      { ...file, method: "GET", body: new Uint8Array() },
      rigAccess(MEMBER),
      no("no_matching_op"),
    ),
    vector(
      "reused create",
      good,
      create,
      createAccess(MEMBER),
      no("replayed"),
      used(0),
    ),
    vector(
      "reused exec, both listed copies used",
      good,
      exec,
      rigAccess(MEMBER),
      no("replayed"),
      used(1, 3),
    ),
    vector(
      "member creates a rig for another owner",
      good,
      { method: "POST", path: "/v0beta1/rigs", body: createForBob },
      createAccess(BOB),
      no("not_allowed"),
    ),
    vector(
      "create without an owner",
      good,
      create,
      createAccess(null),
      no("not_allowed"),
    ),
    vector(
      "member execs in another user's rig",
      good,
      exec,
      rigAccess(BOB),
      no("not_allowed"),
    ),
  ];
}

function payloadBytes(envelope: { payload: string }): Uint8Array {
  const bytes = fromBase64Url(envelope.payload);
  if (bytes === null) throw new Error("bad payload");
  return bytes;
}

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] ^= 0x01;
  return copy;
}

function flipSig(sig: string): string {
  const bytes = fromBase64Url(sig);
  if (bytes === null) throw new Error("bad sig");
  return toBase64Url(flip(bytes, 0));
}
