import { AmikaError } from "../errors.js";
import type { RefKind, ResourceRef } from "../resource-ref.js";

/**
 * The one place a {@link ResourceRef} becomes wire output. Every call site that
 * identifies a resource maps its reference through these helpers, so the
 * validation and the three wire spellings (a path segment plus a `by`-style
 * query selector, `*_id`/`*_name`/`*_ref` fields, and a query value plus a
 * selector) stay consistent.
 *
 * Nothing here looks inside the string: a plain string is always a `ref`, and
 * only the object form pins another kind.
 */

const KINDS: readonly RefKind[] = ["id", "name", "ref"];

/**
 * Reject a value that is a dot segment. `encodeURIComponent` leaves dots
 * alone and the URL parser `fetch` uses collapses `.` and `..` (and their
 * percent-encoded forms), so `/rigs/dev/services/..` would reach
 * `/rigs/dev/` instead: a different route than the caller named.
 */
function rejectDotSegment(value: string, label: string): void {
  if (value === "." || value === "..") {
    throw new AmikaError(`${label} must not be "." or ".."`);
  }
}

/** A plain identifier as an encoded path segment, refusing dot segments. */
export function pathSegment(value: string, label: string): string {
  rejectDotSegment(value, label);
  return encodeURIComponent(value);
}

/**
 * A deprecated alias as a list-filter candidate: a blank value keeps its old
 * meaning there, no filter, instead of failing validation.
 */
export function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** A validated reference. `pinned` is false for a plain string. */
export interface NormalizedRef {
  value: string;
  kind: RefKind;
  pinned: boolean;
}

/**
 * Validate a reference and split it into its value and kind. `label` names the
 * parameter in the error, e.g. "rig".
 */
export function normalizeRef(ref: unknown, label: string): NormalizedRef {
  if (typeof ref === "string") {
    if (!ref.trim()) throw new AmikaError(`${label} must not be empty`);
    rejectDotSegment(ref, label);
    return { value: ref, kind: "ref", pinned: false };
  }
  if (typeof ref !== "object" || ref === null) {
    throw new AmikaError(
      `${label} must be a string or an object of the form { ref, by }`,
    );
  }
  const { ref: value, by } = ref as { ref?: unknown; by?: unknown };
  if (typeof value !== "string") {
    throw new AmikaError(`${label}.ref must be a string`);
  }
  if (!value.trim()) throw new AmikaError(`${label} must not be empty`);
  rejectDotSegment(value, label);
  if (!KINDS.includes(by as RefKind)) {
    throw new AmikaError(
      `${label}.by must be one of "id", "name", or "ref" (got ${JSON.stringify(by)})`,
    );
  }
  return { value, kind: by as RefKind, pinned: true };
}

/** A deprecated ID-only alias as a reference; undefined stays undefined. */
export function idRef(id: string | undefined): ResourceRef | undefined {
  return id === undefined ? undefined : { ref: id, by: "id" };
}

function isBlank(ref: unknown): boolean {
  if (typeof ref === "string") return !ref.trim();
  if (typeof ref === "object" && ref !== null) {
    const value = (ref as { ref?: unknown }).ref;
    return typeof value === "string" && !value.trim();
  }
  return false;
}

/**
 * Choose among a canonical reference field and its deprecated aliases, listed
 * in precedence order. The first non-empty candidate wins, so an empty
 * canonical value falls through to an alias rather than shadowing it (the
 * SDK's long-standing `||` convention). Returns undefined when every candidate
 * is absent, and throws when some were given but all are empty. The chosen
 * candidate is validated.
 */
export function pickRef(
  label: string,
  ...candidates: (ResourceRef | undefined)[]
): NormalizedRef | undefined {
  // null counts as absent too, for untyped JavaScript callers.
  const given = candidates.filter((c) => c !== undefined && c !== null);
  if (given.length === 0) return undefined;
  const chosen = given.find((c) => !isBlank(c)) ?? given[0];
  return normalizeRef(chosen, label);
}

/** The value as an encoded path segment. */
export function refPathSegment(ref: NormalizedRef): string {
  return encodeURIComponent(ref.value);
}

/**
 * A query selector (`by`, or a namespaced one such as `sandbox_by`) for a
 * reference carried in the path or another query parameter. A pinned kind is
 * always sent. A plain string sends `plainKind` when the server's default for
 * an omitted selector is not `ref`, and nothing otherwise, so plain-string
 * requests stay as they were before the selector existed.
 */
export function setRefSelector(
  params: URLSearchParams,
  name: string,
  ref: NormalizedRef,
  plainKind?: RefKind,
): void {
  if (ref.pinned) params.set(name, ref.kind);
  else if (plainKind !== undefined) params.set(name, plainKind);
}

/**
 * The mutually exclusive `{prefix}_id` / `{prefix}_name` / `{prefix}_ref`
 * spelling used in request bodies and some list filters. A plain string uses
 * `{prefix}_ref`.
 */
export function refFieldName(prefix: string, ref: NormalizedRef): string {
  return `${prefix}_${ref.kind}`;
}

/** `?query` or "" for an empty parameter set. */
export function queryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
