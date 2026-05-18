/**
 * Deterministic short hash used to derive stable IDs for review items from
 * their content. FNV-1a 64-bit, truncated to 12 hex characters. This is
 * collision-resistant enough for in-memory item identity (~2^-24 collision
 * probability across hundreds of items) and is fully synchronous, unlike
 * crypto.subtle.digest. Same input always produces the same output, so
 * shareable deep-links survive reloads.
 */
export function hashItemId(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}
