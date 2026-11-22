/**
 * Who owns a rig or snapshot: your organization, or one of your product's
 * end-users. `externalId` is your own id for the end-user, as in
 * `end_user:<externalId>`.
 */
export type ResourceOwner =
  | { kind: "org" }
  | { kind: "end_user"; externalId: string };

/**
 * Whose resources an organization caller lists: `org` (the server's
 * default) for the organization's own, `end_user` for those of its
 * end-users, or `any` for both. An end-user caller always gets only its
 * own, whatever this says.
 */
export type OwnerFilter = "org" | "end_user" | "any";
