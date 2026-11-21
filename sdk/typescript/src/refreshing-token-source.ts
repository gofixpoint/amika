import { AmikaError } from "./errors.js";
import type { TokenSource } from "./token-source.js";

/** A bearer token and when it stops working. */
export interface ExpiringToken {
  token: string;
  /** A `Date`, or an ISO 8601 string such as a principal token's `expiresAt`. */
  expiresAt: Date | string;
}

/** Options for {@link refreshingTokenSource}. */
export interface RefreshingTokenSourceOptions {
  /**
   * Get a new token. In an end-user's client app, call your own backend,
   * which mints a principal token with `client.principalTokens.mint` and
   * returns it.
   */
  fetchToken: () => Promise<ExpiringToken>;
  /**
   * Get the next token this many seconds before the current one expires.
   * Default 60, and never negative. For a token that lives less than twice
   * this, the source gets the next one halfway through its life.
   */
  refreshBeforeSeconds?: number;
  /** The clock, in milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
}

/**
 * A {@link TokenSource} for short-lived tokens, such as principal tokens. It
 * keeps the current token, and calls `fetchToken` for the next one before
 * the current one expires. Requests that arrive during a refresh wait for
 * the same call. If a refresh fails while the current token still works, the
 * source keeps using it and tries again on the next request.
 *
 * @example
 * const client = new AmikaClient({
 *   baseUrl: "https://app.amika.dev",
 *   tokenSource: refreshingTokenSource({
 *     fetchToken: async () => {
 *       const res = await fetch("/my-backend/amika-token", { method: "POST" });
 *       return res.json(); // { token, expiresAt }
 *     },
 *   }),
 * });
 */
export function refreshingTokenSource(
  options: RefreshingTokenSourceOptions,
): TokenSource {
  if (typeof options.fetchToken !== "function") {
    throw new AmikaError(
      "refreshingTokenSource: fetchToken must be a function",
    );
  }
  const marginSeconds = options.refreshBeforeSeconds ?? 60;
  // A negative margin would serve a token after it expires.
  if (!Number.isFinite(marginSeconds) || marginSeconds < 0) {
    throw new AmikaError(
      "refreshingTokenSource: refreshBeforeSeconds must be a number, 0 or more",
    );
  }
  const marginMs = marginSeconds * 1000;
  const now = options.now ?? Date.now;

  let current: {
    token: string;
    refreshAtMs: number;
    expiresAtMs: number;
  } | null = null;
  let inFlight: Promise<string> | null = null;

  const fetchNext = async (): Promise<string> => {
    const fetchedAtMs = now();
    const next = await options.fetchToken();
    const expiresAtMs = new Date(next.expiresAt).getTime();
    if (
      typeof next.token !== "string" ||
      next.token.length === 0 ||
      Number.isNaN(expiresAtMs)
    ) {
      throw new AmikaError(
        "refreshingTokenSource: fetchToken must return a token and a valid expiresAt",
      );
    }
    // A stale token, or a short one that expired while the call ran, would
    // only get 401s.
    if (expiresAtMs <= now()) {
      throw new AmikaError(
        "refreshingTokenSource: fetchToken returned a token that has expired",
      );
    }
    const lifeMs = expiresAtMs - fetchedAtMs;
    current = {
      token: next.token,
      expiresAtMs,
      refreshAtMs: expiresAtMs - Math.min(marginMs, lifeMs / 2),
    };
    return next.token;
  };

  const refresh = (): Promise<string> => {
    if (inFlight) return inFlight;
    // Clear the shared call only after it is stored. A `finally` inside the
    // call runs before the store when `fetchToken` throws before it returns
    // a promise, and the failed call would then stay cached for good.
    const call = fetchNext();
    inFlight = call;
    const clear = () => {
      if (inFlight === call) inFlight = null;
    };
    call.then(clear, clear);
    return call;
  };

  return {
    async token() {
      if (current && now() < current.refreshAtMs) return current.token;
      try {
        return await refresh();
      } catch (error) {
        if (current && now() < current.expiresAtMs) return current.token;
        throw error;
      }
    },
  };
}
