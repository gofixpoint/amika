/**
 * Shell helpers for the provider layer. Prefer argv-style command APIs when
 * available; use `shellQuote` only when a command must be assembled as a
 * shell string.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
