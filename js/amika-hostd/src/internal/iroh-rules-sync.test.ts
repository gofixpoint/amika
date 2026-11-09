import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RulesPayload } from "@amika/iroh-rules";
import type { IrohRulesAnswer } from "./amika-api.js";
import {
  BUILT_IN_TRUSTED_KEYS,
  droppedEndpoints,
  rulesSync,
  trustedRulesKeys,
} from "./iroh-rules-sync.js";
import {
  AMIKA_KEY,
  ENDPOINTS,
  OTHER_KEY,
  basePayload,
  signed,
} from "../testing/iroh.js";

const ORG = "org_vectors";

function harness(answers: IrohRulesAnswer[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "hd-rules-"));
  const file = path.join(dir, "iroh-rules.json");
  const out: string[] = [];
  const err: string[] = [];
  const fetchRules = vi.fn(
    async (_have: number | null): Promise<IrohRulesAnswer> =>
      answers.shift() ?? { kind: "unchanged" },
  );
  const revoke = vi.fn((_ids: string[]) => {});
  const notAllowed = vi.fn(() => {});
  const make = () =>
    rulesSync({
      file,
      orgId: ORG,
      trustedKeys: [AMIKA_KEY.public_hex],
      fetchRules,
      revoke,
      notAllowed,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
  return { file, out, err, fetchRules, revoke, notAllowed, make, answers };
}

function version(n: number, edit: (p: RulesPayload) => void = () => {}) {
  const payload = basePayload();
  payload.version = n;
  edit(payload);
  return payload;
}

describe("rulesSync", () => {
  it("asks with no version, then with the one it holds", async () => {
    const h = harness([
      { kind: "rules", envelope: await signed(version(42)) },
      { kind: "unchanged" },
    ]);
    const sync = h.make();
    expect(await sync.sync()).toBe("accepted");
    expect(await sync.sync()).toBe("unchanged");
    expect(h.fetchRules.mock.calls).toEqual([[null], [42]]);
    expect(sync.rules()?.version).toBe(42);
  });

  it("keeps no rules on a 204", async () => {
    const h = harness([{ kind: "unchanged" }]);
    const sync = h.make();
    expect(await sync.sync()).toBe("unchanged");
    expect(sync.rules()).toBeNull();
  });

  it("accepts a newer record, logs its signer and version, and keeps it 0600", async () => {
    const h = harness([
      { kind: "rules", envelope: await signed(version(42)) },
      { kind: "rules", envelope: await signed(version(43)) },
    ]);
    const sync = h.make();
    await sync.sync();
    expect(await sync.sync()).toBe("accepted");
    expect(sync.rules()?.version).toBe(43);
    expect(h.out).toContain(
      `amika-hostd: accepted iroh rules version 43, signed by amika key ${AMIKA_KEY.public_hex}`,
    );
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(h.file, "utf8"))).toEqual(
      await signed(version(43)),
    );
  });

  it.each([
    ["the same version", 42, AMIKA_KEY.seed_hex, "old_version"],
    ["an older version", 41, AMIKA_KEY.seed_hex, "old_version"],
    ["a forged signer", 50, OTHER_KEY.seed_hex, "untrusted_key"],
  ])(
    "refuses %s and keeps the old rules",
    async (_name, next, seed, reason) => {
      const h = harness([
        { kind: "rules", envelope: await signed(version(42)) },
        { kind: "rules", envelope: await signed(version(next), seed) },
      ]);
      const sync = h.make();
      await sync.sync();
      expect(await sync.sync()).toBe("refused");
      expect(sync.rules()?.version).toBe(42);
      expect(h.err.join("\n")).toContain(`refused iroh rules (${reason}`);
      expect(h.err.join("\n")).toContain("keeping version 42");
    },
  );

  it("refuses a record whose bytes changed after signing", async () => {
    const envelope = await signed(version(42));
    const bytes = Buffer.from(envelope.payload, "base64url");
    bytes[bytes.length - 2] ^= 1;
    const h = harness([
      {
        kind: "rules",
        envelope: { ...envelope, payload: bytes.toString("base64url") },
      },
    ]);
    const sync = h.make();
    expect(await sync.sync()).toBe("refused");
    expect(sync.rules()).toBeNull();
  });

  it("refuses rules for another org", async () => {
    const h = harness([
      {
        kind: "rules",
        envelope: await signed(version(42, (p) => (p.org_id = "org_other"))),
      },
    ]);
    expect(await h.make().sync()).toBe("refused");
  });

  it("revokes the devices and services new rules drop", async () => {
    const h = harness([
      { kind: "rules", envelope: await signed(version(42)) },
      {
        kind: "rules",
        envelope: await signed(
          version(43, (p) => {
            p.devices = p.devices.filter(
              (d) => d.endpoint_id !== ENDPOINTS.member,
            );
            p.services = p.services.filter(
              (s) => s.endpoint_id !== ENDPOINTS.dialer,
            );
          }),
        ),
      },
    ]);
    const sync = h.make();
    await sync.sync();
    expect(h.revoke).not.toHaveBeenCalled();
    await sync.sync();
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith([
      ENDPOINTS.member,
      ENDPOINTS.dialer,
    ]);
  });

  it("loads the kept rules after a restart, and asks for newer ones", async () => {
    const h = harness([{ kind: "rules", envelope: await signed(version(42)) }]);
    await h.make().sync();
    const restarted = h.make();
    await restarted.load();
    expect(restarted.rules()?.version).toBe(42);
    expect(h.out).toContain(
      `amika-hostd: loaded iroh rules version 42, signed by amika key ${AMIKA_KEY.public_hex}`,
    );
    await restarted.sync();
    expect(h.fetchRules).toHaveBeenLastCalledWith(42);
  });

  it("ignores kept rules it can no longer verify", async () => {
    const h = harness();
    writeFileSync(
      h.file,
      JSON.stringify(await signed(version(42), OTHER_KEY.seed_hex)),
    );
    const sync = h.make();
    await sync.load();
    expect(sync.rules()).toBeNull();
    expect(h.err.join("\n")).toContain("ignoring the stored iroh rules");
  });

  it("keeps the old rules when the fetch fails", async () => {
    const h = harness([{ kind: "rules", envelope: await signed(version(42)) }]);
    const sync = h.make();
    await sync.sync();
    h.fetchRules.mockRejectedValueOnce(new Error("network down"));
    expect(await sync.sync()).toBe("failed");
    expect(sync.rules()?.version).toBe(42);
  });

  it("stops and says so when the org no longer allows tunnel_iroh", async () => {
    const h = harness([
      { kind: "rules", envelope: await signed(version(42)) },
      { kind: "not_allowed" },
    ]);
    const sync = rulesSync({
      file: h.file,
      orgId: ORG,
      trustedKeys: [AMIKA_KEY.public_hex],
      fetchRules: h.fetchRules,
      revoke: h.revoke,
      notAllowed: h.notAllowed,
      out: () => {},
      err: () => {},
      intervalMs: 5,
    });
    sync.start();
    await vi.waitFor(() => expect(h.notAllowed).toHaveBeenCalledOnce());
    expect(h.fetchRules).toHaveBeenCalledTimes(2);
    expect(sync.rules()?.version).toBe(42);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.fetchRules).toHaveBeenCalledTimes(2);
  });
});

describe("droppedEndpoints", () => {
  it("drops nothing on the first rules", () => {
    expect(droppedEndpoints(null, basePayload())).toEqual([]);
  });
});

describe("trustedRulesKeys", () => {
  it("uses the built-in list for an API environment, empty for now", () => {
    expect(trustedRulesKeys("https://app.amika.dev", undefined)).toEqual([]);
    expect(BUILT_IN_TRUSTED_KEYS["https://app.staging-amika.dev"]).toEqual([]);
  });

  it("replaces the list with the configured keys", () => {
    expect(
      trustedRulesKeys("https://app.amika.dev", [AMIKA_KEY.public_hex]),
    ).toEqual([AMIKA_KEY.public_hex]);
  });

  it("trusts no key on an API it has no list for", () => {
    expect(trustedRulesKeys("http://localhost:3000", undefined)).toEqual([]);
  });
});
