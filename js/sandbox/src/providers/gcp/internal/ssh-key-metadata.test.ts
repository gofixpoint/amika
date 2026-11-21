import { afterEach, describe, expect, it, vi } from "vitest";
import { gcpTarget } from "./client";
import { GOOGLE_TOKEN_URI } from "./credentials";
import { gcpSshKey, sshKeysMetadata } from "./ssh-key";
import { ensureGcpSshKeyMetadata } from "./ssh-key-metadata";
import { TEST_CONFIG } from "./test-key";

const target = gcpTarget(TEST_CONFIG);
const current = sshKeysMetadata(gcpSshKey(target.credentials, "vm-1"));

afterEach(() => vi.unstubAllGlobals());

function stubCompute(sshKeys: string) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      if (String(url) === GOOGLE_TOKEN_URI) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        );
      }
      const method = init.method ?? "GET";
      calls.push({
        method,
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "ssh-keys", value: sshKeys },
                { key: "amika-sandbox-name", value: "rig" },
              ],
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({ name: "op", status: "DONE", zone: "z" }),
      );
    }),
  );
  return calls;
}

describe("ensureGcpSshKeyMetadata", () => {
  it("changes nothing when the VM has the current key", async () => {
    const calls = stubCompute(current);
    expect(await ensureGcpSshKeyMetadata(target, "vm-1")).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("puts the current key back after the service account key changed", async () => {
    const calls = stubCompute("amika:ssh-ed25519 OLDKEY amika");
    expect(await ensureGcpSshKeyMetadata(target, "vm-1")).toBe(true);
    const set = calls.find((c) => c.url.includes("/setMetadata"));
    expect(set?.body).toEqual({
      fingerprint: "fp-1",
      items: [
        { key: "amika-sandbox-name", value: "rig" },
        { key: "ssh-keys", value: current },
      ],
    });
  });
});
