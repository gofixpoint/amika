/**
 * Byte encodings for the envelope: base64url with no padding, lowercase
 * hex, and lowercase base32 for fingerprints and recovery codes. Plain
 * `Uint8Array` code, so it runs in a Worker as well as Node.
 */

/** Encode `bytes` as base64url with no padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 0x3f];
  }
  return out;
}

/**
 * Decode base64url with no padding. Returns `null` for any other text:
 * padding, the standard alphabet's `+` and `/`, whitespace, a length that
 * no byte string encodes to, or nonzero unused bits. So each byte string has
 * exactly one accepted encoding.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = DECODE.get(char);
    if (value === undefined) return null;
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** Encode `bytes` as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decode lowercase hex. Returns `null` for any other text. */
export function fromHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode `bytes` as RFC 4648 base32, lowercase, with no padding. */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/**
 * Decode lowercase RFC 4648 base32 with no padding. Returns `null` for any
 * other text, a length that no byte string encodes to, or nonzero unused
 * bits.
 */
export function fromBase32(text: string): Uint8Array<ArrayBuffer> | null {
  if (BASE32_BAD_LENGTHS.has(text.length % 8)) return null;
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE32_DECODE.get(char);
    if (value === undefined) return null;
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const BASE32_DECODE = new Map([...BASE32].map((char, value) => [char, value]));

/** Lengths mod 8 that no byte string encodes to. */
const BASE32_BAD_LENGTHS = new Set([1, 3, 6]);

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const DECODE = new Map([...ALPHABET].map((char, value) => [char, value]));
