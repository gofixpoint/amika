#!/usr/bin/env node
"use strict";

// Restores the request identity a sandbox provider's proxy erases in front of
// Pi Web.
//
// Pi Web guards its `/api/*` routes by rebuilding the origin it expects as
// `new URL(request.url).protocol + "//" + <Host header>` and requiring the
// browser's `Origin` to equal it (`isApiRequestOriginAllowed` in Pi Web's
// `lib/request-security.ts`). Both halves of that expectation depend on headers
// a proxy controls: Next.js takes the protocol from `X-Forwarded-Proto`, and the
// host comes from `Host`. Daytona's sandbox proxy terminates TLS, rewrites
// `Host` to `localhost:<port>`, and sends no `X-Forwarded-Proto` at all, so Pi
// Web expects `http://localhost:60996` while the browser sends
// `Origin: https://<sandbox>.daytonaproxy01.net`. Every request carrying an
// Origin is then answered `403 {"error":"Untrusted API request"}`; browsers omit
// Origin on same-origin GETs, so the UI loads and only writes fail — selecting a
// project in the Pi UI was impossible.
//
// Upstream bug: https://github.com/agegr/pi-web/issues/497. Pi Web exposes no
// origin allow-list to configure around it — `PI_WEB_ALLOWED_HOSTS` only feeds
// its separate Host check — so the identity has to be restored before Pi Web
// sees the request.
//
// Both headers are rewritten only towards a host the shim already trusts: the
// public hostname Amika minted for this sandbox, or the `Host` the request
// already carries. An `Origin` naming anything else is forwarded untouched and
// still rejected by Pi Web, so a cross-origin page gains nothing by asking. That
// keeps the check Pi Web's own Host allow-list performs, which is where the CSRF
// and DNS-rebinding signal actually lives.

const http = require("node:http");

const UPSTREAM_HOST = "127.0.0.1";

const [listenPortArgument, upstreamPortArgument, publicHostArgument] = process.argv.slice(2);
const listenPort = Number(listenPortArgument);
const upstreamPort = Number(upstreamPortArgument);

if (!Number.isInteger(listenPort) || !Number.isInteger(upstreamPort)) {
  console.error(`usage: ${process.argv[1]} <listen-port> <pi-web-port> [public-host]`);
  process.exit(64);
}

// RFC 9110 hop-by-hop headers: they describe this connection, not the message,
// so they must not be copied onto the upstream one. Dropping `transfer-encoding`
// also lets Node frame the forwarded body itself instead of double-encoding it.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * `host:port` in the spelling Pi Web compares, or null when the value could not
 * be one. Rejecting a `Host` that carries a path, userinfo or whitespace keeps a
 * malformed header from matching anything.
 */
function normalizeAuthority(value) {
  if (!value || /[\s/@\\]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  return parsed.port ? `${hostname}:${parsed.port}` : hostname;
}

const publicHost = normalizeAuthority(publicHostArgument);

/**
 * The `Host` and scheme to hand Pi Web, or null to forward the request as it
 * arrived.
 *
 * Trusting the `Origin` here would hand Pi Web's Host allow-list whatever a page
 * claimed, so the header is only ever restored to the sandbox's own public
 * hostname or to the `Host` the request already carries.
 */
function repairedIdentity(headers) {
  const origin = headers.origin;
  if (!origin) return null; // same-origin GETs and non-browser clients

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null; // includes the opaque `Origin: null`
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const originAuthority = normalizeAuthority(parsed.host);
  if (originAuthority === null) return null;

  const scheme = parsed.protocol.slice(0, -1);
  if (publicHost !== null && originAuthority === publicHost) {
    return { host: parsed.host, scheme };
  }
  // A proxy that keeps Host intact and only loses the scheme needs no rewrite,
  // just the scheme it dropped.
  if (headers.host && normalizeAuthority(headers.host) === originAuthority) {
    return { host: headers.host, scheme };
  }
  return null;
}

function forwardedHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name)) forwarded[name] = value;
  }

  const identity = repairedIdentity(headers);
  if (identity !== null) {
    forwarded.host = identity.host;
    // A real proxy in front that already reported the scheme knows better.
    if (!forwarded["x-forwarded-proto"]) forwarded["x-forwarded-proto"] = identity.scheme;
  }

  return forwarded;
}

const server = http.createServer((request, response) => {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request.headers),
  });

  upstream.on("response", (upstreamResponse) => {
    // Raw headers keep repeated fields such as `Set-Cookie` intact, and piping
    // without buffering keeps Pi Web's streaming responses live.
    response.writeHead(
      upstreamResponse.statusCode,
      upstreamResponse.statusMessage,
      upstreamResponse.rawHeaders,
    );
    upstreamResponse.pipe(response);
  });

  upstream.on("error", (error) => {
    console.error(`pi-web-shim: upstream request failed: ${error.message}`);
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("pi-web-shim: Pi Web is unreachable\n");
  });

  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

// An upgraded connection never reaches the request handler above, so it needs
// its own tunnel.
server.on("upgrade", (request, clientSocket, head) => {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, ...forwardedHeaders(request.headers) },
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`;
    const headerLines = [];
    for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
      headerLines.push(
        `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`,
      );
    }
    clientSocket.write(`${[statusLine, ...headerLines].join("\r\n")}\r\n\r\n`);

    for (const socket of [clientSocket, upstreamSocket]) {
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.on("error", () => socket.destroy());
    }

    // Bytes that arrived alongside the handshake belong at the front of each
    // stream; unshifting them lets the pipes below carry them in order.
    if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
    if (head?.length) clientSocket.unshift(head);

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstream.on("error", (error) => {
    console.error(`pi-web-shim: upstream upgrade failed: ${error.message}`);
    clientSocket.destroy();
  });

  clientSocket.on("error", () => upstream.destroy());
  upstream.end();
});

server.on("error", (error) => {
  console.error(`pi-web-shim: ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(
    `pi-web-shim listening on 0.0.0.0:${listenPort}, forwarding to ${UPSTREAM_HOST}:${upstreamPort}` +
      (publicHost === null ? "" : ` as ${publicHost}`),
  );
});
