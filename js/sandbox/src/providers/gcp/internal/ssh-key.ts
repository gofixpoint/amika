/**
 * The SSH key Amika logs in to one VM with.
 *
 * The provider keeps no state, so the key is derived, not stored: its
 * ed25519 seed is an HMAC of the VM's project and name, keyed with the
 * service account's private key. The same key and VM always give the same
 * SSH key, every VM gets a different one, and only a holder of the service
 * account key can derive it. A holder of that key can already change any VM
 * in the project, so the SSH key grants nothing more.
 *
 * Create puts the public half in the VM's `ssh-keys` metadata, which
 * Google's guest agent installs for the `amika` user.
 */
import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import type { GcpCredentials } from "./credentials";

/** The Linux user Amika logs in as. The guest agent gives it `sudo`. */
export const GCP_SSH_USER = "amika";

/** Bump to give every VM created after it a different key. */
const KEY_DERIVATION_LABEL = "amika-gcp-ssh-v1";

/** The DER prefix of a PKCS #8 ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

const KEY_TYPE = "ssh-ed25519";

export interface GcpSshKey {
  /** The private key in OpenSSH format, which `ssh2` reads. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… amika`, the `authorized_keys` line. */
  publicKey: string;
}

/** The SSH key for VM `instanceName`. */
export function gcpSshKey(
  credentials: GcpCredentials,
  instanceName: string,
): GcpSshKey {
  const seed = createHmac("sha256", credentials.privateKey)
    .update(
      `${KEY_DERIVATION_LABEL}\0${credentials.projectId}\0${instanceName}`,
    )
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const pub = Buffer.from(jwk.x ?? "", "base64url");
  const pubBlob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  return {
    privateKey: openSshPrivateKey(seed, pub, pubBlob),
    publicKey: `${KEY_TYPE} ${pubBlob.toString("base64")} ${GCP_SSH_USER}`,
  };
}

/** The `ssh-keys` metadata value: `user:key` lines. */
export function sshKeysMetadata(key: GcpSshKey): string {
  return `${GCP_SSH_USER}:${key.publicKey}`;
}

/**
 * An unencrypted `openssh-key-v1` private key
 * (https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key).
 * `ssh2` cannot read an ed25519 key in PKCS #8, so we write this format.
 */
function openSshPrivateKey(seed: Buffer, pub: Buffer, pubBlob: Buffer): string {
  // The two check words only have to match each other.
  const check = uint32(0x616d696b);
  let section = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(GCP_SSH_USER),
  ]);
  const padding: number[] = [];
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i++) {
    padding.push(i);
  }
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(pubBlob),
    sshString(section),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
}

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}
