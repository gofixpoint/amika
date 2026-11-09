import { describe, expect, it, vi } from "vitest";
import { hostIrohKey, parseIrohKey } from "./iroh-host-key.js";

/** RFC 8032's test key 1, standing in for a host key. */
const SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

function store(value?: string) {
  const secret = {
    description: "the test store",
    value,
    get: vi.fn(() => secret.value),
    set: vi.fn((next: string) => {
      secret.value = next;
    }),
  };
  return secret;
}

describe("hostIrohKey", () => {
  it("makes the key on first use and keeps it in the store", () => {
    const secret = store();
    const generate = vi.fn(() => Uint8Array.from(Buffer.from(SEED_HEX, "hex")));
    const first = hostIrohKey(secret, generate);
    expect(first.created).toBe(true);
    expect(secret.set).toHaveBeenCalledExactlyOnceWith(SEED_HEX);
    const second = hostIrohKey(secret, generate);
    expect(second).toEqual({ key: first.key, created: false });
    expect(generate).toHaveBeenCalledOnce();
    expect(Buffer.from(second.key).toString("hex")).toBe(SEED_HEX);
  });

  it("refuses a stored value that is not a key, without quoting it", () => {
    const secret = store("not-a-key-but-maybe-secret");
    expect(() => hostIrohKey(secret)).toThrow(/is not 32 bytes of hex/);
    expect(() => hostIrohKey(secret)).not.toThrow(/not-a-key/);
  });

  it("makes a 32-byte key by default", () => {
    expect(hostIrohKey(store()).key).toHaveLength(32);
  });
});

describe("parseIrohKey", () => {
  it("reads 64 hex characters, and nothing else", () => {
    expect(parseIrohKey(SEED_HEX)).toHaveLength(32);
    expect(parseIrohKey(SEED_HEX.slice(2))).toBeUndefined();
    expect(parseIrohKey(SEED_HEX.toUpperCase())).toBeUndefined();
  });
});
