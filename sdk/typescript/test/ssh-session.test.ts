import { describe, it, expect } from "vitest";

import {
  canonicalEd25519PublicKey,
  isValidSSHSession,
  type SSHSession,
} from "@/ssh-session";

const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4ilkUClOhQyh1hQBSn7N/cMSpX0oqg4P87b21Qqdvt";
const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC093npR5HAcy4a1CdTWnMAe5lK3JX6FupbkO8y3qy+2to99D9Y1DhC/CqDAU1GBBD7mKhrg4kb7QZJR+3F";

// 32 zero bytes in unpadded base64url — the canonical shape of a connect token.
const CONNECT_CREDENTIAL = "A".repeat(42) + "Q";

function validSession(overrides: Partial<SSHSession> = {}): SSHSession {
  return {
    sessionId: "sshs_abc123",
    transport: "direct_ws",
    connectUrl: "wss://relay.example.com/v1/ssh-sessions",
    connectCredential: CONNECT_CREDENTIAL,
    sandboxId: "sbx_1",
    sshUser: "amika",
    hostPublicKey: ED25519_KEY,
    ...overrides,
  };
}

describe("canonicalEd25519PublicKey", () => {
  it("strips the comment and returns the canonical line", () => {
    expect(canonicalEd25519PublicKey(`${ED25519_KEY} jakub@example.com`)).toBe(
      ED25519_KEY,
    );
  });

  it("tolerates surrounding whitespace and a trailing newline", () => {
    expect(canonicalEd25519PublicKey(`  ${ED25519_KEY} laptop  \n`)).toBe(
      ED25519_KEY,
    );
  });

  it("rejects a non-ed25519 key", () => {
    expect(canonicalEd25519PublicKey(RSA_KEY)).toBe("");
  });

  it("rejects authorized_keys options", () => {
    expect(canonicalEd25519PublicKey(`no-pty ${ED25519_KEY}`)).toBe("");
  });

  it("rejects a second key on another line", () => {
    expect(canonicalEd25519PublicKey(`${ED25519_KEY}\n${ED25519_KEY}`)).toBe(
      "",
    );
  });

  it("rejects a blob whose algorithm name disagrees with the prefix", () => {
    // An ssh-rsa blob relabelled as ssh-ed25519.
    const relabelled = `ssh-ed25519 ${RSA_KEY.split(" ")[1]}`;
    expect(canonicalEd25519PublicKey(relabelled)).toBe("");
  });

  it("rejects malformed base64 and empty input", () => {
    expect(canonicalEd25519PublicKey("ssh-ed25519 not!base64")).toBe("");
    expect(canonicalEd25519PublicKey("ssh-ed25519")).toBe("");
    expect(canonicalEd25519PublicKey("")).toBe("");
  });
});

describe("isValidSSHSession", () => {
  it("accepts a well-formed descriptor for the expected sandbox", () => {
    expect(isValidSSHSession(validSession(), "sbx_1")).toBe(true);
  });

  it("rejects a descriptor for a different sandbox", () => {
    expect(isValidSSHSession(validSession(), "sbx_2")).toBe(false);
  });

  it.each([
    ["a session id without the sshs_ prefix", { sessionId: "abc" }],
    ["an over-long session id", { sessionId: "sshs_" + "a".repeat(200) }],
    ["an unknown transport", { transport: "relay_ws" }],
    ["a non-amika ssh user", { sshUser: "root" }],
    [
      "a non-wss connect URL",
      { connectUrl: "https://r.example/v1/ssh-sessions" },
    ],
    [
      "a connect URL with a query",
      { connectUrl: "wss://r.example/v1/ssh-sessions?x=1" },
    ],
    [
      "a connect URL with userinfo",
      { connectUrl: "wss://u:p@r.example/v1/ssh-sessions" },
    ],
    [
      "a connect URL with the wrong path",
      { connectUrl: "wss://r.example/v1/other" },
    ],
    [
      "a connect credential that is not 32 bytes",
      { connectCredential: "AAAA" },
    ],
    [
      "a padded connect credential",
      { connectCredential: CONNECT_CREDENTIAL + "==" },
    ],
    ["a host key that is not ed25519", { hostPublicKey: RSA_KEY }],
  ])("rejects %s", (_label, overrides) => {
    expect(isValidSSHSession(validSession(overrides), "sbx_1")).toBe(false);
  });
});
