import type { OwnerFilter, ResourceOwner } from "../owner.js";

/**
 * The `owner` of a response, or undefined when an older server omits it or
 * sends a kind this SDK does not know.
 */
export function ownerFromWire(v: unknown): ResourceOwner | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const w = v as Record<string, unknown>;
  if (w["kind"] === "org") return { kind: "org" };
  if (w["kind"] === "end_user" && typeof w["external_id"] === "string") {
    return { kind: "end_user", externalId: w["external_id"] };
  }
  return undefined;
}

/** Adds the `owner` list filter to `params` when the caller set one. */
export function setOwnerParam(
  params: URLSearchParams,
  owner: OwnerFilter | undefined,
): void {
  if (owner !== undefined) params.set("owner", owner);
}
