/**
 * How the server matches a reference value:
 *
 * - `id`: by the resource's ID only.
 * - `name`: by the resource's name only.
 * - `ref`: by ID or name; the server rejects a value that is one resource's ID
 *   and another's name with `409 resource_ref_ambiguous`.
 */
export type RefKind = "id" | "name" | "ref";

/**
 * Identifies a resource by ID, name, or either.
 *
 * A plain string is a `ref`: the server matches it by ID or name and rejects a
 * value that is one resource's ID and another's name (409). The object form
 * pins the kind, as in `{ ref: "dev", by: "name" }` or
 * `{ ref: rig.id, by: "id" }`. The SDK never infers a kind from the string's
 * contents, so a prefix such as `name=` is part of the value.
 *
 * An empty `ref` (including one of only whitespace) is rejected with
 * `AmikaError` before any request is made.
 */
export type ResourceRef = string | { ref: string; by: RefKind };

/**
 * Identifies a rig. A plain string matches the rig's ID or name; use
 * `{ ref, by: "id" }` or `{ ref, by: "name" }` to pin one. See
 * {@link ResourceRef}.
 */
export type RigRef = ResourceRef;
