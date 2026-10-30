/**
 * What a service sees in `Host` when hostd forwards to it.
 *
 * By default the loopback address hostd dials, `127.0.0.1:<port>`, as a
 * reverse proxy leaves it: a dev server that accepts only `localhost`
 * (Vite's host check, which guards against DNS rebinding) keeps answering,
 * and a framework reads the public name from `X-Forwarded-Host` instead.
 * A service created with `preserve_host` sees its public name, because it
 * compares `Origin` with `Host` before it acts, or builds its links from
 * `Host`. The name is always the one the gateway signed, never a caller's.
 *
 * Setting it takes two forms. An upgrade is written onto the guest socket
 * as bytes (`services.ts`), so the header is written like any other. An
 * HTTP request goes through `fetch`, where `Host` is a forbidden header
 * that `fetch` replaces with the URL's authority, so the name is set below
 * `fetch`, on the dispatch to the guest, which undici lets a dispatcher's
 * interceptor do.
 */
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * The `Host` a named request's service sees: its public name with
 * `preserveHost`, else the loopback address of the guest port.
 */
export function guestHost(
  preserveHost: boolean,
  publicHost: string,
  hostPort: number,
): string {
  return preserveHost ? publicHost : `127.0.0.1:${hostPort}`;
}

/** The fetch `proxyService` forwards with, and the agent its dispatchers compose. */
export const guestFetch = undiciFetch as unknown as typeof fetch;
const agent = new Agent();

/**
 * A dispatcher that sends every request with `host` as its `Host`, whatever
 * authority the URL names. For `fetch(url, { dispatcher })`.
 */
export function dispatchWithHost(host: string): Dispatcher {
  return agent.compose((dispatch) => (options, handler) => {
    const headers = withoutHost(options.headers);
    headers.push("host", host);
    return dispatch({ ...options, headers }, handler);
  });
}

/**
 * `headers` as a flat `[name, value, ...]` list without any `Host`, which
 * is how undici's fetch hands them to a dispatcher; the other shapes a
 * dispatcher may be given are read the same way.
 */
function withoutHost(headers: Dispatcher.DispatchOptions["headers"]): string[] {
  const pairs: [string, string][] = [];
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      pairs.push([String(headers[i]), String(headers[i + 1])]);
    }
  } else if (
    headers &&
    typeof headers === "object" &&
    Symbol.iterator in headers
  ) {
    for (const [name, value] of headers as Iterable<[string, string]>) {
      pairs.push([name, value]);
    }
  } else if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value])
        pairs.push([name, v]);
    }
  }
  return pairs.filter(([name]) => name.toLowerCase() !== "host").flat();
}
