/** A repository known to the caller's org, from GET /api/v0beta1/repositories. */
export interface RemoteRepository {
  /** Resource identifier assigned by the server. */
  id: string;
  /** Repository clone URL. */
  repoUrl: string;
}

/** Repositories operations available on AmikaClient. */
export interface Repositories {
  /** List repositories known to your organization. */
  list(): Promise<RemoteRepository[]>;
}
