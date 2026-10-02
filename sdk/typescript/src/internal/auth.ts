import { AmikaError } from "../errors.js";
import type { AmikaClientOptions } from "../options.js";
import type { TokenSource } from "../token-source.js";
import { StaticTokenSource } from "./token.js";

export function resolveTokenSource(options: AmikaClientOptions): TokenSource {
  const sources = [options.apiKey, options.accessToken, options.tokenSource];
  if (sources.filter((source) => source !== undefined).length !== 1) {
    throw new AmikaError(
      "AmikaClient: provide exactly one of apiKey, accessToken, or tokenSource",
    );
  }
  if (options.tokenSource !== undefined) {
    if (
      !options.tokenSource ||
      typeof options.tokenSource.token !== "function"
    ) {
      throw new AmikaError(
        "AmikaClient: tokenSource must provide a token() method",
      );
    }
    return options.tokenSource;
  }
  const token = options.apiKey ?? options.accessToken;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new AmikaError(
      "AmikaClient: apiKey or accessToken must be a non-empty string",
    );
  }
  return new StaticTokenSource(token);
}
