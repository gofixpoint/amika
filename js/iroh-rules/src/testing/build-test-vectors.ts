/**
 * Build `test-vectors.json`: fixed keys, payloads, envelopes and the
 * results every verifier must reach, so a Go or Rust verifier can run the
 * same cases. Ed25519 is deterministic, so the output is stable.
 *
 * Run `pnpm run update-test-vectors` after a change here. The tests fail
 * while the committed file differs from this output.
 */
import { fromBase64Url, fromHex, toBase64Url } from "../internal/encoding";
import type { RulesEnvelope, RulesPayload } from "../internal/rules";
import { encodePayload, rulesPublicKey, signRules } from "../internal/sign";
import { buildLockVectors, type LockVectors } from "./build-lock-vectors";

export interface TestVectors extends LockVectors {
  description: string[];
  keys: Record<KeyName, { seed_hex: string; public_hex: string }>;
  payloads: Record<string, RulesPayload>;
  verify: VerifyVector[];
  check_peer: CheckPeerVector[];
  check_target: CheckTargetVector[];
  parse_target: ParseTargetVector[];
  parse_endpoint_id: { input: string; valid: boolean }[];
}

export interface VerifyVector {
  name: string;
  envelope: unknown;
  options: {
    trusted_keys: string[];
    trusted_kinds: string[];
    org_id: string;
    have_version: number | null;
    known_formats: number[];
    known_features: string[];
  };
  expect:
    | { ok: true; key_id: string; kind: string; version: number }
    | { ok: false; reason: string };
}

export interface CheckPeerVector {
  name: string;
  payload: string;
  endpoint_id: string;
  expect:
    | { allowed: false }
    | { allowed: true; kind: "device"; device_id: string; principal_id: string }
    | { allowed: true; kind: "service"; service: string };
}

export interface CheckTargetVector {
  name: string;
  payload: string;
  endpoint_id: string;
  target: string;
  rig_owner: { kind: "user"; id: string } | null;
  expect: { allowed: true } | { allowed: false; reason: string };
}

export interface ParseTargetVector {
  input: string;
  expect:
    | null
    | { kind: "hostd" }
    | { kind: "rig"; rig_id: string; port: number };
}

type KeyName = "amika" | "other" | "org_admin";

/**
 * Test-only keys: the secret keys of RFC 8032's Ed25519 tests 1, 2 and 3.
 * They are public, so nothing may trust them outside tests.
 */
const SEEDS: Record<KeyName, string> = {
  amika: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  other: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  org_admin: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
};

const ORG = "org_vectors";

/** Endpoint ids for the payload's devices and services. Not keys. */
const EP = {
  adminLaptop: "a1".repeat(32),
  memberLaptop: "b2".repeat(32),
  portsLaptop: "c3".repeat(32),
  noRoleLaptop: "d4".repeat(32),
  dialer: "e5".repeat(32),
  controlPlane: "f6".repeat(32),
  forwarder: "07".repeat(32),
  stranger: "99".repeat(32),
};

const BASE: RulesPayload = {
  format: 1,
  required_features: [],
  org_id: ORG,
  version: 42,
  issued_at: 1794200000000,
  principals: [
    { kind: "user", id: "user_admin", role: "admin" },
    { kind: "user", id: "user_member", role: "member" },
    { kind: "user", id: "user_ports", role: "ssh_only" },
    { kind: "user", id: "user_ghost", role: "ghost" },
  ],
  devices: [
    device("dev_01JADMINLAPTOP000000000000", EP.adminLaptop, "user_admin"),
    device("dev_01JMEMBERLAPTOP00000000000", EP.memberLaptop, "user_member"),
    device("dev_01JPORTSLAPTOP000000000000", EP.portsLaptop, "user_ports"),
    device("dev_01JNOROLELAPTOP00000000000", EP.noRoleLaptop, "user_ghost"),
  ],
  roles: {
    admin: { rigs: "all", ports: "all" },
    member: { rigs: "own", ports: "all" },
    ssh_only: { rigs: "own", ports: [22, 8080] },
  },
  services: [
    { service: "dialer", endpoint_id: EP.dialer, targets: ["hostd"] },
    {
      service: "control_plane",
      endpoint_id: EP.controlPlane,
      targets: ["hostd"],
    },
    {
      service: "forwarder",
      endpoint_id: EP.forwarder,
      targets: ["rig:rig-shared:22"],
    },
  ],
};

function device(device_id: string, endpoint_id: string, user: string) {
  return {
    device_id,
    endpoint_id,
    principal: { kind: "user" as const, id: user },
  };
}

export async function buildTestVectors(): Promise<TestVectors> {
  const keys = await buildKeys();
  const lock = await buildLockVectors(BASE);
  return {
    description: [
      "Test vectors for @amika/iroh-rules (spec 035, iroh-contracts.md).",
      "The keys are RFC 8032's public test keys. Never trust them outside tests.",
      "Each verify vector's options are the verifier's inputs; have_version null means the host has no rules.",
      "A check_target vector runs check_peer on endpoint_id first; the peer is always allowed there.",
      "Locked orgs (phase 1b): lock_keys are fixed test seeds; lock_logs are valid logs that other vectors name by key.",
      "A verify_locked_rules vector's lock names a lock_logs entry; verify that log first to get the host's lock state.",
      "A check_signed_request vector's context.rules names a payload; context.used lists the (nonce, index) pairs already used.",
      "Generated by src/testing/build-test-vectors.ts; run `pnpm run update-test-vectors`.",
    ],
    keys,
    payloads: { base: BASE, locked: lock.lockedPayload },
    verify: await buildVerifyVectors(keys),
    check_peer: CHECK_PEER,
    check_target: CHECK_TARGET,
    parse_target: PARSE_TARGET,
    parse_endpoint_id: PARSE_ENDPOINT_ID,
    ...lock.vectors,
  };
}

async function buildKeys(): Promise<TestVectors["keys"]> {
  const entries = await Promise.all(
    (Object.keys(SEEDS) as KeyName[]).map(async (name) => {
      const public_hex = await rulesPublicKey(seed(name));
      return [name, { seed_hex: SEEDS[name], public_hex }] as const;
    }),
  );
  return Object.fromEntries(entries) as TestVectors["keys"];
}

function seed(name: KeyName): Uint8Array {
  const bytes = fromHex(SEEDS[name]);
  if (bytes === null) throw new Error(`bad seed ${name}`);
  return bytes;
}

async function buildVerifyVectors(
  keys: TestVectors["keys"],
): Promise<VerifyVector[]> {
  const amika = keys.amika.public_hex;
  const other = keys.other.public_hex;
  const orgAdmin = keys.org_admin.public_hex;
  const options = (over: Partial<VerifyVector["options"]> = {}) => ({
    trusted_keys: [amika],
    trusted_kinds: ["amika"],
    org_id: ORG,
    have_version: null,
    known_formats: [1],
    known_features: [],
    ...over,
  });
  const ok = (key_id: string, version = 42, kind = "amika") =>
    ({ ok: true, key_id, kind, version }) as const;
  const no = (reason: string) => ({ ok: false, reason }) as const;

  const bytes = encodePayload(BASE);
  const signed = await sign(bytes, "amika");
  const byOther = await sign(bytes, "other");
  const text = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));

  return [
    {
      name: "valid record, host has no rules",
      envelope: signed,
      options: options(),
      expect: ok(amika),
    },
    {
      name: "valid record, newer than the host's",
      envelope: signed,
      options: options({ have_version: 41 }),
      expect: ok(amika),
    },
    {
      name: "one of several trusted keys signed",
      envelope: signed,
      options: options({ trusted_keys: [other, amika] }),
      expect: ok(amika),
    },
    {
      name: "same version as the host's",
      envelope: signed,
      options: options({ have_version: 42 }),
      expect: no("old_version"),
    },
    {
      name: "older than the host's",
      envelope: signed,
      options: options({ have_version: 50 }),
      expect: no("old_version"),
    },
    {
      name: "record for another org",
      envelope: signed,
      options: options({ org_id: "org_someone_else" }),
      expect: no("wrong_org"),
    },
    {
      name: "signed only by an untrusted key",
      envelope: byOther,
      options: options(),
      expect: no("untrusted_key"),
    },
    {
      name: "trusted key, but its kind is not trusted",
      envelope: await sign(bytes, "amika", { kind: "org" }),
      options: options(),
      expect: no("untrusted_kind"),
    },
    {
      name: "one payload byte changed after signing",
      envelope: { ...signed, payload: toBase64Url(flipByte(bytes, 10)) },
      options: options(),
      expect: no("bad_signature"),
    },
    {
      name: "signature bytes changed",
      envelope: {
        ...signed,
        signatures: [
          {
            ...signed.signatures[0],
            sig: toBase64Url(flipByte(sigBytes(signed), 0)),
          },
        ],
      },
      options: options(),
      expect: no("bad_signature"),
    },
    {
      name: "signature of another payload",
      envelope: {
        ...signed,
        signatures: (await sign(text({ ...BASE, version: 43 }), "amika"))
          .signatures,
      },
      options: options(),
      expect: no("bad_signature"),
    },
    {
      name: "untrusted signature first, trusted signature second",
      envelope: {
        payload: signed.payload,
        signatures: [...byOther.signatures, ...signed.signatures],
      },
      options: options(),
      expect: ok(amika),
    },
    {
      name: "trusted signature, then a signature of unknown shape",
      envelope: {
        payload: signed.payload,
        signatures: [...signed.signatures, { kind: "future", scheme: "pq" }],
      },
      options: options(),
      expect: ok(amika),
    },
    {
      name: "org signer with principal and device id, org kind trusted",
      envelope: await sign(bytes, "org_admin", {
        kind: "org",
        principal: { kind: "user", id: "user_admin" },
        device_id: "dev_01JADMINLAPTOP000000000000",
      }),
      options: options({
        trusted_keys: [amika, orgAdmin],
        trusted_kinds: ["amika", "org"],
      }),
      expect: ok(orgAdmin, 42, "org"),
    },
    {
      name: "unknown optional fields at every level are ignored",
      envelope: await sign(
        text({
          ...BASE,
          future_top: { anything: [1, 2] },
          principals: BASE.principals.map((p) => ({ ...p, note: "x" })),
          devices: BASE.devices.map((d) => ({ ...d, label: "laptop" })),
          roles: {
            ...BASE.roles,
            admin: { rigs: "all", ports: "all", tags: [] },
          },
          services: BASE.services.map((s) => ({ ...s, since: 1 })),
        }),
        "amika",
      ),
      options: options(),
      expect: ok(amika),
    },
    {
      name: "required feature the host does not know",
      envelope: await sign(
        text({ ...BASE, required_features: ["rig_tags"] }),
        "amika",
      ),
      options: options(),
      expect: no("unknown_feature"),
    },
    {
      name: "required feature the host knows",
      envelope: await sign(
        text({ ...BASE, required_features: ["rig_tags"] }),
        "amika",
      ),
      options: options({ known_features: ["rig_tags"] }),
      expect: ok(amika),
    },
    {
      name: "record that needs lock_v1, host without lock_v1",
      envelope: await sign(
        text({ ...BASE, required_features: ["lock_v1"] }),
        "amika",
      ),
      options: options(),
      expect: no("unknown_feature"),
    },
    {
      name: "org-signed record that needs lock_v1, host without lock_v1 that trusts the key",
      envelope: await sign(
        text({ ...BASE, required_features: ["lock_v1"] }),
        "org_admin",
        {
          kind: "org",
          principal: { kind: "user", id: "user_admin" },
          device_id: "dev_01JADMINLAPTOP000000000000",
        },
      ),
      options: options({
        trusted_keys: [amika, orgAdmin],
        trusted_kinds: ["amika", "org"],
      }),
      expect: no("unknown_feature"),
    },
    {
      name: "Amika-signed lock offer is not a required feature",
      envelope: await sign(
        text({ ...BASE, lock_offer: { lock_id: "ab".repeat(32) } }),
        "amika",
      ),
      options: options(),
      expect: ok(amika),
    },
    {
      name: "format the host does not know",
      envelope: await sign(text({ format: 2, whatever: true }), "amika"),
      options: options(),
      expect: no("unknown_format"),
    },
    {
      name: "unparseable payload signed by an untrusted key: signature first",
      envelope: await sign(new TextEncoder().encode("not json"), "other"),
      options: options(),
      expect: no("untrusted_key"),
    },
    {
      name: "signed payload is not JSON",
      envelope: await sign(new TextEncoder().encode("not json"), "amika"),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "signed payload is not UTF-8",
      envelope: await sign(new Uint8Array([0x7b, 0xff, 0x7d]), "amika"),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "signed payload has no org_id",
      envelope: await sign(text({ ...BASE, org_id: undefined }), "amika"),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "signed payload has an unknown rigs value",
      envelope: await sign(
        text({ ...BASE, roles: { admin: { rigs: "tagged", ports: "all" } } }),
        "amika",
      ),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "signed payload lists one endpoint twice",
      envelope: await sign(
        text({
          ...BASE,
          services: [
            ...BASE.services,
            { service: "copy", endpoint_id: EP.adminLaptop, targets: [] },
          ],
        }),
        "amika",
      ),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "signed payload has a bad service target",
      envelope: await sign(
        text({
          ...BASE,
          services: [
            { service: "dialer", endpoint_id: EP.dialer, targets: ["rig:x"] },
          ],
        }),
        "amika",
      ),
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "envelope has no signatures",
      envelope: { payload: signed.payload, signatures: [] },
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "envelope is not an object",
      envelope: "rules",
      options: options(),
      expect: no("malformed"),
    },
    {
      name: "payload is padded base64",
      envelope: { ...signed, payload: `${signed.payload}==` },
      options: options(),
      expect: no("malformed"),
    },
  ];

  async function sign(
    payloadBytes: Uint8Array,
    key: KeyName,
    signer: {
      kind?: string;
      principal?: { kind: "user"; id: string };
      device_id?: string;
    } = {},
  ): Promise<RulesEnvelope> {
    return signRules(payloadBytes, {
      kind: "amika",
      ...signer,
      privateKey: seed(key),
    });
  }
}

function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] ^= 0x01;
  return copy;
}

function sigBytes(envelope: RulesEnvelope): Uint8Array {
  const bytes = fromBase64Url(envelope.signatures[0].sig);
  if (bytes === null) throw new Error("signRules wrote bad base64url");
  return bytes;
}

const CHECK_PEER: CheckPeerVector[] = [
  {
    name: "admin's device",
    payload: "base",
    endpoint_id: EP.adminLaptop,
    expect: {
      allowed: true,
      kind: "device",
      device_id: "dev_01JADMINLAPTOP000000000000",
      principal_id: "user_admin",
    },
  },
  {
    name: "member's device",
    payload: "base",
    endpoint_id: EP.memberLaptop,
    expect: {
      allowed: true,
      kind: "device",
      device_id: "dev_01JMEMBERLAPTOP00000000000",
      principal_id: "user_member",
    },
  },
  {
    name: "device whose principal has no role: check 1 passes, check 2 refuses",
    payload: "base",
    endpoint_id: EP.noRoleLaptop,
    expect: {
      allowed: true,
      kind: "device",
      device_id: "dev_01JNOROLELAPTOP00000000000",
      principal_id: "user_ghost",
    },
  },
  {
    name: "dialer service",
    payload: "base",
    endpoint_id: EP.dialer,
    expect: { allowed: true, kind: "service", service: "dialer" },
  },
  {
    name: "control plane service",
    payload: "base",
    endpoint_id: EP.controlPlane,
    expect: { allowed: true, kind: "service", service: "control_plane" },
  },
  {
    name: "endpoint not in the rules",
    payload: "base",
    endpoint_id: EP.stranger,
    expect: { allowed: false },
  },
  {
    name: "uppercase spelling of a known endpoint",
    payload: "base",
    endpoint_id: EP.adminLaptop.toUpperCase(),
    expect: { allowed: false },
  },
];

const ALICE = { kind: "user" as const, id: "user_member" };
const BOB = { kind: "user" as const, id: "user_bob" };
const PORTS = { kind: "user" as const, id: "user_ports" };
const GHOST = { kind: "user" as const, id: "user_ghost" };

const CHECK_TARGET: CheckTargetVector[] = [
  target(
    "admin reaches another user's rig",
    EP.adminLaptop,
    "rig:rig-bob:22",
    BOB,
    true,
  ),
  target(
    "admin reaches a rig with no owner",
    EP.adminLaptop,
    "rig:rig-x:3000",
    null,
    true,
  ),
  target(
    "admin's device may not open hostd",
    EP.adminLaptop,
    "hostd",
    null,
    "not_allowed",
  ),
  target(
    "member reaches own rig",
    EP.memberLaptop,
    "rig:rig-alice:22",
    ALICE,
    true,
  ),
  target(
    "member reaches any port on own rig",
    EP.memberLaptop,
    "rig:rig-alice:65535",
    ALICE,
    true,
  ),
  target(
    "member may not reach another user's rig",
    EP.memberLaptop,
    "rig:rig-bob:22",
    BOB,
    "not_allowed",
  ),
  target(
    "member may not reach a rig with no owner",
    EP.memberLaptop,
    "rig:rig-x:22",
    null,
    "not_allowed",
  ),
  target(
    "member's device may not open hostd",
    EP.memberLaptop,
    "hostd",
    null,
    "not_allowed",
  ),
  target(
    "port-limited role, listed port",
    EP.portsLaptop,
    "rig:rig-p:8080",
    PORTS,
    true,
  ),
  target(
    "port-limited role, unlisted port",
    EP.portsLaptop,
    "rig:rig-p:3000",
    PORTS,
    "port_not_allowed",
  ),
  target(
    "port-limited role, another user's rig",
    EP.portsLaptop,
    "rig:rig-bob:22",
    BOB,
    "not_allowed",
  ),
  target(
    "principal whose role is not defined",
    EP.noRoleLaptop,
    "rig:rig-g:22",
    GHOST,
    "not_allowed",
  ),
  target("dialer opens hostd", EP.dialer, "hostd", null, true),
  target(
    "dialer may not open a rig target",
    EP.dialer,
    "rig:rig-alice:22",
    ALICE,
    "not_allowed",
  ),
  target("control plane opens hostd", EP.controlPlane, "hostd", null, true),
  target(
    "control plane may not open a rig target",
    EP.controlPlane,
    "rig:rig-x:22",
    null,
    "not_allowed",
  ),
  target(
    "service opens its listed rig target",
    EP.forwarder,
    "rig:rig-shared:22",
    null,
    true,
  ),
  target(
    "service may not open another port of that rig",
    EP.forwarder,
    "rig:rig-shared:23",
    null,
    "not_allowed",
  ),
  target(
    "service may not open hostd when it is not listed",
    EP.forwarder,
    "hostd",
    null,
    "not_allowed",
  ),
];

function target(
  name: string,
  endpoint_id: string,
  targetText: string,
  rig_owner: CheckTargetVector["rig_owner"],
  result: true | "not_allowed" | "port_not_allowed",
): CheckTargetVector {
  return {
    name,
    payload: "base",
    endpoint_id,
    target: targetText,
    rig_owner,
    expect:
      result === true ? { allowed: true } : { allowed: false, reason: result },
  };
}

const LONGEST_RIG_ID = `r${"a".repeat(127)}`;

const PARSE_TARGET: ParseTargetVector[] = [
  { input: "hostd", expect: { kind: "hostd" } },
  { input: "rig:rig-1:22", expect: { kind: "rig", rig_id: "rig-1", port: 22 } },
  { input: "rig:A_b-9:1", expect: { kind: "rig", rig_id: "A_b-9", port: 1 } },
  { input: "rig:x:65535", expect: { kind: "rig", rig_id: "x", port: 65535 } },
  {
    input: `rig:${LONGEST_RIG_ID}:22`,
    expect: { kind: "rig", rig_id: LONGEST_RIG_ID, port: 22 },
  },
  { input: `rig:${LONGEST_RIG_ID}a:22`, expect: null },
  { input: "rig:x:65536", expect: null },
  { input: "rig:x:0", expect: null },
  { input: "rig:x:022", expect: null },
  { input: "rig:x:+22", expect: null },
  { input: "rig:x:22.0", expect: null },
  { input: "rig:x:", expect: null },
  { input: "rig:x", expect: null },
  { input: "rig::22", expect: null },
  { input: "rig:-x:22", expect: null },
  { input: "rig:_x:22", expect: null },
  { input: "rig:a.b:22", expect: null },
  { input: "rig:a:b:22", expect: null },
  { input: "rig:a/b:22", expect: null },
  { input: "RIG:x:22", expect: null },
  { input: "HOSTD", expect: null },
  { input: " hostd", expect: null },
  { input: "hostd\n", expect: null },
  { input: "rig:x:22\n", expect: null },
  { input: "rig:x:22 ", expect: null },
  { input: "", expect: null },
];

const PARSE_ENDPOINT_ID: TestVectors["parse_endpoint_id"] = [
  { input: "0123456789abcdef".repeat(4), valid: true },
  { input: "0123456789ABCDEF".repeat(4), valid: false },
  { input: "0".repeat(63), valid: false },
  { input: "0".repeat(65), valid: false },
  { input: `0x${"0".repeat(62)}`, valid: false },
  { input: `${"0".repeat(63)}g`, valid: false },
  { input: `${"0".repeat(64)}\n`, valid: false },
  { input: "", valid: false },
];
