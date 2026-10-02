import type { TokenSource } from "../token-source.js";
export class StaticTokenSource implements TokenSource {
  constructor(private readonly accessToken: string) {}

  token(): string {
    return this.accessToken;
  }
}
