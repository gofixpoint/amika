/**
 * A short-lived token that acts as one end-user of your product. Your
 * backend mints it with an organization API key that has the
 * `end-users:act-as` permission, and gives it to that end-user's client
 * app. Requests with the token reach only that end-user's hosts and rigs.
 */
export interface PrincipalToken {
  /** Token identifier, `pt_…`. Pass it to `revoke`. */
  id: string;
  /** The bearer token, `amk_pt_…`. Returned only once, by `mint`. */
  token: string;
  /** When the token stops working. */
  expiresAt: string;
}

/** Request for {@link PrincipalTokens.mint}. */
export interface MintPrincipalTokenRequest {
  /**
   * The end-user the token acts as, as `end_user:<external_id>`, where the
   * external id is your own id for the end-user. Amika creates the end-user
   * on the first mint.
   */
  principal: string;
  /** Token lifetime in seconds. Default 3600 (1 hour), maximum 86400. */
  ttlSeconds?: number;
}

/** Mint and revoke principal tokens for your product's end-users (beta). */
export interface PrincipalTokens {
  /** Mint a token for one end-user. */
  mint(request: MintPrincipalTokenRequest): Promise<PrincipalToken>;
  /** Revoke a token. It stops working at once. */
  revoke(id: string): Promise<void>;
}
