/** Supplies a bearer token for each API request, synchronously or asynchronously. */
export interface TokenSource {
  /** Return the current token. Custom sources are responsible for refreshing or caching it. */
  token(): string | Promise<string>;
}
