/**
 * TokenSource provides a bearer token for API requests. Mirrors Go's
 * `apiclient.TokenSource`.
 *
 * The SDK ships one built-in implementation (`StaticTokenSource`). Advanced
 * callers can implement their own — for example, a token source that fetches
 * from a secret manager and caches with a TTL.
 */
export interface TokenSource {
  token(): Promise<string> | string;
}

export class StaticTokenSource implements TokenSource {
  constructor(private readonly accessToken: string) {}

  token(): string {
    return this.accessToken;
  }
}
