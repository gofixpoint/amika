import type { ResourceRef } from "../resource-ref.js";

/**
 * Identifies a cloud account. A plain string matches the account's ID or
 * name; `{ ref, by: "id" }` or `{ ref, by: "name" }` pins one. See
 * {@link ResourceRef}. The name `amika` always means Amika Cloud.
 */
export type CloudAccountRef = ResourceRef;

/**
 * An organization's own account at a sandbox provider (bring your own cloud),
 * as the /cloud-accounts endpoints return it. Rigs in it run on the
 * organization's provider quota and bill. The API key is never returned.
 */
export interface CloudAccount {
  /** Resource identifier assigned by the server, `cacc_…`. */
  id: string;
  /** The sandbox provider the account is at, e.g. `e2b`, `daytona`, or `instabox`. */
  provider: string;
  /** Unique per provider in the organization. */
  name: string;
  /**
   * True when a rig create that names this provider and no account lands in
   * this account. A provider has at most one default.
   */
  isDefault: boolean;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
}

/** Request body for connecting a cloud account. */
export interface CreateCloudAccountRequest {
  /** The sandbox provider, e.g. `e2b`, `daytona`, or `instabox`. */
  provider: string;
  /**
   * 1 to 63 of `a-z`, `0-9`, and `-`, starting with a letter or digit. Unique
   * per provider. `amika` is reserved for Amika Cloud.
   */
  name: string;
  /** The provider API key. Amika stores it and never returns it. */
  apiKey: string;
  /** Make it the provider's default account, replacing the previous default. */
  isDefault?: boolean;
}

/** Changes to a cloud account; omitted fields keep their values. */
export interface UpdateCloudAccountRequest {
  name?: string;
  /** Replaces the stored API key. Each rig uses it from its next operation. */
  apiKey?: string;
  /**
   * True makes it the provider's default, replacing the previous default.
   * False leaves the provider with no default, so rigs go to Amika Cloud.
   */
  isDefault?: boolean;
}

/** Options for reading, changing, or deleting one cloud account. */
export interface CloudAccountLookupOptions {
  /**
   * Match the reference among this provider's accounts only. Names are unique
   * per provider, not per organization, so without it a name two providers
   * share is refused with 409 `resource_ref_ambiguous`.
   */
  provider?: string;
}

/** Filters for listing cloud accounts. */
export interface ListCloudAccountsOptions {
  /** Only this provider's accounts. */
  provider?: string;
}

/** Cloud account operations available on AmikaClient. */
export interface CloudAccounts {
  /**
   * Connect an account. Amika does not test the key. The server refuses with
   * 409 `cloud_account_exists` while the provider already has an account, and
   * `cloud_account_name_taken` when the name is in use for that provider.
   */
  create(req: CreateCloudAccountRequest): Promise<CloudAccount>;

  /** List the organization's connected accounts. */
  list(options?: ListCloudAccountsOptions): Promise<CloudAccount[]>;

  /**
   * Read one account. A plain string matches its ID or name;
   * `{ ref, by: "id" | "name" }` pins one. An unknown account is a 404
   * `cloud_account_not_found`.
   */
  get(
    account: CloudAccountRef,
    options?: CloudAccountLookupOptions,
  ): Promise<CloudAccount>;

  /** Change an account (see {@link UpdateCloudAccountRequest}). */
  update(
    account: CloudAccountRef,
    req: UpdateCloudAccountRequest,
    options?: CloudAccountLookupOptions,
  ): Promise<CloudAccount>;

  /**
   * Disconnect an account and delete its stored key. The server refuses with
   * 409 `cloud_account_in_use` while rigs or snapshots remain in it.
   */
  delete(
    account: CloudAccountRef,
    options?: CloudAccountLookupOptions,
  ): Promise<void>;
}
