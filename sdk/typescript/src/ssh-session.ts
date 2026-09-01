// The SSH transport descriptor behind `amika ssh`, `amika code`, and
// `amika scp`, plus the key validation those commands rely on. Mirrors
// go/internal/apiclient/ssh_session.go.

import { AmikaError } from "@/errors";
import { str } from "@/types";

/** Thrown when an SSH session descriptor is unsafe or internally inconsistent. */
export class InvalidSSHSessionError extends AmikaError {
  override name = "InvalidSSHSessionError";

  constructor() {
    super("invalid SSH session descriptor");
  }
}

/** How the stdio proxy reaches the sandbox. Only `direct_ws` exists today. */
export type SSHSessionTransport = "direct_ws";

/** The provider-exposed no-relay transport. */
export const SSH_SESSION_TRANSPORT_DIRECT_WS: SSHSessionTransport = "direct_ws";

/** The transport descriptor returned for one SSH dial. */
export interface SSHSession {
  sessionId: string;
  transport: SSHSessionTransport | string;
  connectUrl: string;
  connectCredential: string;
  sandboxId: string;
  sshUser: string;
  hostPublicKey: string;
}

export function sshSessionFromWire(w: Record<string, unknown>): SSHSession {
  return {
    sessionId: str(w["session_id"]),
    transport: str(w["transport"]),
    connectUrl: str(w["connect_url"]),
    connectCredential: str(w["connect_credential"]),
    sandboxId: str(w["sandbox_id"]),
    sshUser: str(w["ssh_user"]),
    hostPublicKey: str(w["host_public_key"]),
  };
}

/**
 * Check every field OpenSSH or the WebSocket dialer would act on, and that the
 * descriptor is for the sandbox that was asked for. Returns true when the
 * descriptor is safe to dial.
 */
export function isValidSSHSession(
  session: SSHSession,
  expectedSandboxId: string,
): boolean {
  if (
    session.sessionId === "" ||
    session.sessionId.length > 128 ||
    !session.sessionId.startsWith("sshs_")
  ) {
    return false;
  }
  if (
    session.transport !== SSH_SESSION_TRANSPORT_DIRECT_WS ||
    session.sandboxId !== expectedSandboxId ||
    session.sshUser !== "amika"
  ) {
    return false;
  }
  if (
    !isCanonicalConnectToken(session.connectCredential) ||
    canonicalEd25519PublicKey(session.hostPublicKey) === ""
  ) {
    return false;
  }

  let connectUrl: URL;
  try {
    connectUrl = new URL(session.connectUrl);
  } catch {
    return false;
  }
  if (
    connectUrl.protocol !== "wss:" ||
    connectUrl.host === "" ||
    connectUrl.username !== "" ||
    connectUrl.password !== "" ||
    connectUrl.search !== "" ||
    connectUrl.hash !== ""
  ) {
    return false;
  }
  return connectUrl.pathname.endsWith("/v1/ssh-sessions");
}

/**
 * Validate one OpenSSH ed25519 public key line and return it in canonical form
 * with any comment stripped, or "" if the value is not a well-formed ed25519
 * key. The control plane canonicalizes the same way, so uploading this form
 * keeps a locally read key byte-identical to what the server stores.
 */
export function canonicalEd25519PublicKey(value: string): string {
  const line = value.trim();
  // A single key line only: authorized_keys options, or a second key, are not
  // accepted (matching Go's rejection of options and trailing content).
  if (line === "" || /[\r\n]/.test(line)) return "";

  const fields = line.split(/[ \t]+/);
  const algorithm = fields[0];
  const encoded = fields[1];
  if (algorithm !== ED25519_ALGORITHM || encoded === undefined) return "";

  const blob = decodeBase64(encoded);
  if (!blob) return "";

  const parsed = parseEd25519Blob(blob);
  if (!parsed) return "";

  // Re-encode from the parsed key so the canonical form does not inherit any
  // quirk of the input's base64.
  return `${ED25519_ALGORITHM} ${encodeBase64(buildEd25519Blob(parsed))}`;
}

const ED25519_ALGORITHM = "ssh-ed25519";
const ED25519_KEY_BYTES = 32;
const CONNECT_TOKEN_BYTES = 32;

/** A connect credential is exactly 32 bytes in canonical unpadded base64url. */
function isCanonicalConnectToken(value: string): boolean {
  const decoded = decodeBase64Url(value);
  if (!decoded || decoded.length !== CONNECT_TOKEN_BYTES) return false;
  return encodeBase64Url(decoded) === value;
}

/**
 * Read the SSH wire encoding of an ed25519 public key: the algorithm name and
 * the 32 key bytes, each length-prefixed, with nothing trailing. Returns the
 * key bytes, or null if the blob is not exactly that.
 */
function parseEd25519Blob(blob: Uint8Array): Uint8Array | null {
  const name = readString(blob, 0);
  if (!name) return null;
  if (decodeAscii(name.value) !== ED25519_ALGORITHM) return null;

  const key = readString(blob, name.next);
  if (!key || key.value.length !== ED25519_KEY_BYTES) return null;
  if (key.next !== blob.length) return null;

  return key.value;
}

function buildEd25519Blob(key: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(ED25519_ALGORITHM);
  const out = new Uint8Array(4 + name.length + 4 + key.length);
  writeUint32(out, 0, name.length);
  out.set(name, 4);
  writeUint32(out, 4 + name.length, key.length);
  out.set(key, 8 + name.length);
  return out;
}

function readString(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const length = readUint32(buf, offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buf.length) return null;
  return { value: buf.subarray(start, end), next: end };
}

function readUint32(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] as number) << 24) |
      ((buf[offset + 1] as number) << 16) |
      ((buf[offset + 2] as number) << 8) |
      (buf[offset + 3] as number)) >>>
    0
  );
}

function writeUint32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Strict padded base64, as Go's `base64.StdEncoding` accepts. */
function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return atobToBytes(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Unpadded base64url, as Go's `base64.RawURLEncoding` accepts. */
function decodeBase64Url(value: string): Uint8Array | null {
  if (value === "" || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atobToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function atobToBytes(value: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
