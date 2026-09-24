/** Reject requests that do not present the daemon's shared secret key. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Require `Authorization: Bearer <secret key>`, read the same way as the
 * amika-mono worker's `checkWorkerAuth`: strip a leading `Bearer` scheme,
 * trim, and compare in constant time.
 */
export function requireSecretKey(secretKey: string): MiddlewareHandler {
  return async (c, next) => {
    const provided =
      c.req
        .header("Authorization")
        ?.replace(/^Bearer\s+/i, "")
        .trim() ?? "";
    if (!timingSafeStrEqual(provided, secretKey)) {
      // Close the connection so Node stops reading an unauthenticated body.
      return c.json({ error: "Unauthorized" }, 401, { Connection: "close" });
    }
    await next();
  };
}

/**
 * Compare two strings without leaking their length or content: HMAC both with
 * a per-call random key so `timingSafeEqual` always sees 32-byte buffers.
 */
function timingSafeStrEqual(a: string, b: string): boolean {
  const key = randomBytes(32);
  const aDigest = createHmac("sha256", key).update(a).digest();
  const bDigest = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(aDigest, bDigest);
}
