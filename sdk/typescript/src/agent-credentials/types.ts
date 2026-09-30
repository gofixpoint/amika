/** A stored credential for an agent provider, such as Claude or Codex. */
export interface CreateProviderSecretRequest {
  /** Resource name. */
  name: string;
  /** Secret or credential value to store. It is not returned in metadata responses. */
  value: string;
  /** "oauth" or "api_key" — required by the server. */
  type: "oauth" | "api_key";
  /** "user" (default) or "org"; omit to take the server default. */
  scope?: "user" | "org";
}

/** Metadata returned after storing an agent credential. Contains no secret value. */
export interface ProviderSecretSummary {
  /** Resource identifier assigned by the server. */
  id: string;
  /** Resource name. */
  name: string;
  /** Ownership scope, such as user or org. */
  scope: string;
}

/** Metadata for one stored agent credential. Contains no secret value. */
export interface ProviderSecretListItem {
  /** Resource identifier assigned by the server. */
  id: string;
  /** Resource name. */
  name: string;
  /** Credential type reported by the server. */
  type: string;
  /** "user" or "org". */
  scope: string;
}

/** AgentCredentials operations available on AmikaClient. */
export interface AgentCredentials {
  /** Store an agent credential for a provider such as claude or codex. Returns its metadata. */
  create(
    provider: string,
    req: CreateProviderSecretRequest,
  ): Promise<ProviderSecretSummary>;

  /** List stored credential metadata for the selected agent provider. Values are never returned. */
  list(provider: string): Promise<ProviderSecretListItem[]>;

  /** Delete a stored credential by provider and credential ID. */
  delete(provider: string, id: string): Promise<void>;
}
