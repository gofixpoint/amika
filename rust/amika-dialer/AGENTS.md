# amika-dialer

The dialer serves amika.run requests for hosts on the iroh transport. It
replaces the gateway Workers for those hosts. The design is in amika-mono:
`specs/035-host-connection-drops.d/iroh-transport.md`, "The dialer", and
`iroh-contracts.md`, "Phase 2".

This file uses Simplified Technical English (ASD-STE100). Write new text
here the same way.

## What it does

1. The reverse proxy forwards a request for a rig on an iroh host to the
   dialer. The request has the headers that the gateway gets, and two
   more: `x-amika-endpoint-id` and `x-amika-relay-url`. The assertion
   covers all of them.
2. The dialer checks the assertion (`src/forward.rs`, `src/token.rs`).
3. The dialer opens a QUIC stream to the host's `hostd` target
   (`src/pool.rs`, `src/stream_header.rs`). It keeps one connection for
   each host.
4. The dialer sends the request to hostd as HTTP/1.1 over the stream, and
   streams the response back (`src/server.rs`). After a `101`, it copies
   bytes both ways.

## Rules

- Apply the gateway's checks. `src/forward.rs` is a port of
  `js/gateway-cloudflare/src/forward.ts` in amika-mono, for the dialer
  hop. When that file changes, change this one.
- Keep `tests/service-token-vectors.json` byte-identical to
  `js/service-token/src/test-vectors.json` in amika-mono. Copy the file. Do
  not edit it here.
- The assertion has the dialer hop's label,
  `amika:reverse-proxy->dialer:forward-request:v1`. Its subject holds the
  gateway hop's five values, then the endpoint id, then the relay URL (the
  empty string for no relay). Dial only the endpoint and the relay in it.
- Refuse the control plane's assertion. The dialer hop has no
  control-plane label yet.
- Dial a relay only when it is in `DIALER_RELAY_URLS`, or when that list is
  empty. Compare relay URLs without the trailing dot of the host name.
- Do not log secrets, assertions or cookies.
- Do not commit relay URLs, keys or IP addresses. This repository is
  public.

## The stream header

`src/stream_header.rs` holds the caller's side of the contract's stream
header. `amika-net` holds the host's side. `amika-net` has no library
target, so the dialer cannot use it as a dependency yet. When `amika-net`
gets a library target with the contract's header, use it and delete the
copy here.

## Configuration

| Variable                        | Default        | What it is                                                       |
|---------------------------------|----------------|------------------------------------------------------------------|
| `DIALER_SECRET_KEY`             | required       | The endpoint key: 64 hex digits. Its public key is in the rules. |
| `DIALER_PROXY_SECRET`           | required       | Verifies the proxy's assertions (`PROXY_DIALER_SECRET`).         |
| `DIALER_LISTEN`                 | `0.0.0.0:8080` | The HTTP listener.                                               |
| `DIALER_RELAY`                  | `n0-pro`       | `n0-pro`, `custom`, `n0` (tests only) or `none` (tests only).    |
| `DIALER_RELAY_URLS`             | unset          | Comma-separated relay URLs. Required for `n0-pro` and `custom`.  |
| `DIALER_N0_API_SECRET`          | unset          | The n0 project API secret. Required for `n0-pro`.                |
| `DIALER_RELAY_TOKEN`            | unset          | The shared token for `custom` relays.                            |
| `DIALER_UDP_BIND`               | unset          | The IPv4 UDP bind address. On Fly.io: `fly-global-services:0`.   |
| `DIALER_QUIC_IDLE_TIMEOUT_SECS` | 60             | The QUIC idle timeout.                                           |
| `DIALER_QUIC_KEEPALIVE_SECS`    | 5              | The QUIC keep-alive interval.                                    |
| `DIALER_RESPONSE_TIMEOUT_SECS`  | 100            | The limit on hostd's response head.                              |
| `DIALER_SHUTDOWN_GRACE_SECS`    | 280            | How long shutdown waits for open requests and WebSockets.        |
| `DIALER_LOG`                    | info           | A `tracing` filter.                                              |

Run `amika-dialer keygen` to make a key. It writes the key to stdout and
the endpoint id to stderr. Run `amika-dialer endpoint-id` to print the id
of `DIALER_SECRET_KEY`.

`GET /healthz` answers `200` for a request with no assertion and no
`x-amika-host-id`. With an assertion, the path goes to the rig.

## Fly.io

`fly.toml` and `Dockerfile` deploy the dialer to Fly.io. Run
`fly deploy --app <app>` in this directory. Set the secrets with
`fly secrets set`: `DIALER_SECRET_KEY`, `DIALER_PROXY_SECRET`,
`DIALER_RELAY_URLS` and `DIALER_N0_API_SECRET`.

## Commands

Run these in this directory.

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`tests/end_to_end.rs` runs a fake host and a fake hostd on loopback, with
no relay.
