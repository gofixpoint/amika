/**
 * Mirrors the API's SecretSummary schema, returned by the /secrets endpoints.
 * Never carries the secret's value.
 */
export interface Secret {
  /** Resource identifier assigned by the server. */
  id: string;
  /** Organization that owns this resource. */
  orgId: string;
  /** ID of the user associated with this secret. */
  userId: string;
  /** Resource name. */
  name: string;
  /** Human-readable description; null where none is stored. */
  description: string | null;
  /** "user" or "org". */
  scope: string;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
}

/** A named secret value and its ownership scope. */
export interface CreateSecretRequest {
  /** Resource name. */
  name: string;
  /** Secret or credential value to store. It is not returned in metadata responses. */
  value: string;
  /** Ownership scope, such as user or org. */
  scope: string;
}

/** Replacement value for an existing secret. */
export interface UpdateSecretRequest {
  /** Secret or credential value to store. It is not returned in metadata responses. */
  value: string;
}

/** Secrets operations available on AmikaClient. */
export interface Secrets {
  /** List secret metadata. Secret values are never returned. */
  list(): Promise<Secret[]>;

  /** Store a named secret value for a user or organization. Resolves without a response body. */
  create(req: CreateSecretRequest): Promise<void>;

  /** Replace the value of a stored secret, identified by ID. Resolves without a response body. */
  update(id: string, req: UpdateSecretRequest): Promise<void>;
}
