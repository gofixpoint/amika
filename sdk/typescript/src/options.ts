import type { TokenSource } from "./token-source.js";

/**
 * Client configuration. Provide exactly one credential source. The SDK does not
 * read environment variables or local credential files automatically.
 * @example
 * const client = new AmikaClient({ apiKey: process.env.AMIKA_API_KEY! });
 */
export type AmikaClientOptions = {
  /** API origin, without /api/v0beta1. Defaults to https://app.amika.dev. */
  baseUrl?: string;
  /** Override globalThis.fetch for testing or a runtime polyfill. */
  fetch?: typeof fetch;
  /**
   * Act as one end-user of your product (beta), as `end_user:<external_id>`.
   * Each request then sends the `Amika-As-Principal` header, and reaches only
   * that end-user's hosts and rigs. Needs an organization API key with the
   * `end-users:act-as` permission. See also {@link AmikaClient.actAs}.
   */
  actAs?: string;
} & (
  | {
      /** Static API key; preferred for scripts. Must be non-empty. */
      apiKey: string;
      /** Use apiKey in this configuration. */
      accessToken?: never;
      /** Use apiKey in this configuration. */
      tokenSource?: never;
    }
  | {
      /** Use accessToken in this configuration. */
      apiKey?: never;
      /** Static bearer access token. Must be non-empty. */
      accessToken: string;
      /** Use accessToken in this configuration. */
      tokenSource?: never;
    }
  | {
      /** Use tokenSource in this configuration. */
      apiKey?: never;
      /** Use tokenSource in this configuration. */
      accessToken?: never;
      /** Custom token loader, called for every request. */
      tokenSource: TokenSource;
    }
);
