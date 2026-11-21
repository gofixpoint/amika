import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { parseGcpCredentials } from "./credentials";
import { gcpSshKey, sshKeysMetadata } from "./ssh-key";
import { TEST_CONFIG, TEST_KEY_JSON } from "./test-key";

const creds = parseGcpCredentials(TEST_CONFIG);

describe("gcpSshKey", () => {
  it("is the same for the same VM and different for another", () => {
    expect(gcpSshKey(creds, "vm-a")).toEqual(gcpSshKey(creds, "vm-a"));
    expect(gcpSshKey(creds, "vm-a").publicKey).not.toBe(
      gcpSshKey(creds, "vm-b").publicKey,
    );
  });

  it("depends on the service account key", () => {
    const other = parseGcpCredentials({
      apiKey: JSON.stringify({
        ...TEST_KEY_JSON,
        private_key: TEST_KEY_JSON.private_key.replace("A", "B"),
      }),
    });
    expect(gcpSshKey(other, "vm-a").publicKey).not.toBe(
      gcpSshKey(creds, "vm-a").publicKey,
    );
  });

  it("is an OpenSSH key ssh2 reads, matching the public line", () => {
    const key = gcpSshKey(creds, "vm-a");
    const parsed = utils.parseKey(key.privateKey);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    expect(key.publicKey).toBe(
      `ssh-ed25519 ${parsed.getPublicSSH().toString("base64")} amika`,
    );
    const data = Buffer.from("challenge");
    expect(parsed.verify(data, parsed.sign(data))).toBe(true);
  });

  it("goes in metadata for the amika user", () => {
    expect(sshKeysMetadata(gcpSshKey(creds, "vm-a"))).toMatch(
      /^amika:ssh-ed25519 \S+ amika$/,
    );
  });
});
