/**
 * The host's iroh key: the Ed25519 secret key `amika-net` serves as (spec
 * 035, `iroh-transport.md`, "Keys and secrets").
 *
 * It lives in hostd's secret store, as the 32-byte seed in hex, and never
 * in config.toml. `up` reads it, or makes it on first use, and hands it to
 * the daemon, which passes it to `amika-net` on file descriptor 3. The
 * daemon never opens the store. Only the endpoint id, the public key,
 * leaves the host.
 */
import { randomBytes } from "node:crypto";
import { ConfigError } from "./config.js";
import type { Secret } from "./credentials.js";

/** The seed's length, as `amika-net --key-fd` reads it. */
export const IROH_KEY_BYTES = 32;

/**
 * The host's iroh key from `secret`, made and stored first when there is
 * none. A stored value that is not a key is refused, by name only: the
 * message never quotes it.
 */
export function hostIrohKey(
  secret: Secret,
  generate: () => Uint8Array = () => randomBytes(IROH_KEY_BYTES),
): { key: Uint8Array; created: boolean } {
  const stored = secret.get();
  if (stored !== undefined) {
    if (!IROH_KEY_HEX.test(stored)) {
      throw new ConfigError(
        `The iroh host key in ${secret.description} is not 32 bytes of hex; remove it, and \`amika-hostd up\` makes a new one`,
      );
    }
    return { key: Uint8Array.from(Buffer.from(stored, "hex")), created: false };
  }
  const key = generate();
  if (key.length !== IROH_KEY_BYTES) {
    throw new Error(`an iroh host key is ${IROH_KEY_BYTES} bytes`);
  }
  secret.set(Buffer.from(key).toString("hex"));
  return { key, created: true };
}

/** Parse the hex form `up` hands the daemon; undefined if it is not a key. */
export function parseIrohKey(hex: string): Uint8Array | undefined {
  return IROH_KEY_HEX.test(hex)
    ? Uint8Array.from(Buffer.from(hex, "hex"))
    : undefined;
}

const IROH_KEY_HEX = /^[0-9a-f]{64}$/;
