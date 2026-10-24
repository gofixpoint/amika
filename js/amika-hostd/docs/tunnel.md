# Outbound tunnel

A host behind a home router has no way to be reached. Today an operator
solves that themselves: ngrok, a port forward, cloudflared, and then
`amika-hostd register-url` to tell Amika where the tunnel came out. That is
a second service to run, a second thing to pay for, and a URL that changes.

Tunnel mode removes it. The daemon binds nothing and **dials out** to an
Amika-run gateway over WSS. The gateway holds one yamux session per host and
opens one stream for each public request it forwards. hostd serves each of
those streams with the same Hono app, the same authentication and the same
upgrade handler a listening daemon serves, so no route exists twice.

This document covers the client half, which lives in this repo. The gateway
is in amika-mono (`js/gateway`), and the design both ends implement is spec
025, `specs/025-hostd-outbound-tunnel.md` there.

## The pieces

`src/internal/` is flat, so the tunnel is a set of files rather than a
directory:

| File                    | What it owns                                                |
| ----------------------- | ----------------------------------------------------------- |
| `tunnel-dial.ts`        | The WSS handshake, and what the gateway's answer means      |
| `tunnel-byte-stream.ts` | The WebSocket, read by the multiplexer as ordered bytes     |
| `tunnel-frame-guard.ts` | A length check on an inbound DATA frame, before the decoder |
| `tunnel-attachment.ts`  | One live session: the yamux muxer, liveness, draining       |
| `tunnel-socket.ts`      | One yamux stream, shaped like a socket for `node:http`      |
| `tunnel-serving.ts`     | An `http.Server` with no listener, fed those sockets        |
| `tunnel-backoff.ts`     | How long to wait before dialling again                      |
| `tunnel-client.ts`      | The loop: dial, serve, decide what a disconnect meant       |
| `tunnel-target.ts`      | Where to attach, and what to prove it with                  |

## Decisions

### The credential is a host-scoped bearer token

hostd already keeps two secrets, and the tunnel uses neither.

- The **Amika API key** acts as the user across their whole organization.
  Spec 025 forbids reusing it, and `setup` already keeps it out of the
  daemon's environment.
- The **secret key** authorizes Amika's requests _into_ this daemon and
  signs service links. Attaching a host is the opposite direction and a
  different permission.

So the tunnel adds a third secret, `attachment-credential`, in the same
store as the other two (`credentials.ts`): a keychain item, or a file beside
`api-key` with the file store. It is minted by the control plane at
enrolment, in exchange for the user's API key, and it is worth only this
host's inbound traffic.

**Why a bearer token and not a signed assertion over a keypair**, which spec
025 prefers for the long term: the gateway re-presents the same credential
string on every lease renewal, for the whole life of the attachment. Its
`attachHost` captures the string at attach time and passes it unchanged to
`renewHost` hours later. A proof bound to a timestamp or a challenge would
be valid for the first call and rejected for every renewal after it, and the
gateway has no way to ask the host for a fresh one. A keypair model
therefore needs a change on the gateway side first; the credential is opaque
to the gateway, so making it later changes nothing in this repo but the
enrolment call.

It travels in the `x-amika-host-credential` header of the handshake, beside
`x-amika-host-id`, never in the URL, because a query string reaches the
access log of every proxy on the path and an attachment credential lives
until it is rotated. It is not `Authorization: Bearer`: the gateway does not
know the credential's scheme and hands the whole value to the control plane
unread. These are the names the gateway reads; any other spelling is
refused at the handshake.

### The gateway address comes from the control plane

The control plane records it at enrolment, in
`<state>/tunnel-enrolment.json` beside the host id and the credential
generation. A gateway is deployment configuration Amika owns: hosts move
between staging and production, and a gateway moves between zones. Making
that an operator setting means editing a file on every laptop when it moves.

`tunnel_gateway_url` in `config.toml`, or
`AMIKA_HOSTD_TUNNEL_GATEWAY_URL`, overrides it. That exists for a gateway
running on a developer's own machine, and for pinning one host while an
incident is on.

`wss://` is required. Plain `ws://` is accepted on loopback only, because a
developer's own gateway has no certificate and nothing leaves the machine.
The loopback test is anchored at both ends: `127.0.0.1.evil.example` is a
name anyone can register.

### A ping, not a WebSocket ping, and not the library's keep-alive

The normal way a tunnel dies is a closed laptop lid. The socket stays in
`ESTABLISHED`, the kernel accepts writes, and no WebSocket or TCP event
reports anything. Only an unanswered round trip finds it.

- A **WebSocket ping** is answered by the peer's `ws` library, below the
  multiplexer and below the event loop that serves requests. A pong proves
  bytes move and nothing else.
- **`@libp2p/yamux`'s own keep-alive** sends pings and swallows the error
  when one goes unanswered. Its source carries a `TODO: should abort here?`
  where the abort would be. It cannot report a dead peer, which is the only
  thing this daemon needs it for.

So `TunnelAttachment` disables the library's keep-alive and runs its own:
a yamux ping every `keepAliveIntervalMs`, with a `pingTimeoutMs` deadline,
ending the attachment when one is not answered. A yamux ping is answered by
the peer's multiplexer, so it proves the whole stack a request travels
through.

It pings on a fixed interval rather than only when the tunnel is idle.
Inbound traffic proves the gateway can reach this host; it proves nothing
about the other direction, and a response that cannot be written is the
failure that matters. The cost of being wrong is one 12-byte frame per
interval. The same interval doubles as the idle keep-alive an edge that
closes quiet WebSockets needs.

### Backoff is full jitter with a floor

A gateway deploy drops every host at the same instant. Hosts that all wait
the same growing interval arrive together and knock it over again. So the
wait is drawn uniformly across the whole window rather than nudged a few
percent around it, with a floor under it: full jitter can draw one
millisecond, and the failure that most often repeats immediately is a
gateway that completes the handshake and then drops the connection.

A session that stayed up for `resetAfterMs` resets the schedule. A laptop
that sleeps nightly would otherwise bring last night's cap to this
morning's first reconnect.

### Shutdown closes the WebSocket, and that is the point

`TunnelAttachment.close()` stops accepting streams, lets the requests in
flight finish up to `drainMs`, sends GO_AWAY, and then closes the WebSocket
with 1001 "going away". The close is what releases the attachment at the
gateway: its close handler gives up the route, so a daemon that has gone
does not leave the gateway forwarding into a socket nobody reads. Dropping
the connection instead loses every request sent before the gateway's own
liveness check notices.

A caller with upgraded connections -- SSH, the web terminal, a rig's service
WebSocket -- destroys those first. They are long-lived by design, so waiting
for them always runs the drain out to its bound. Listener-mode shutdown
makes the same distinction (`server.ts`).

Disconnecting is **not** shutdown. A dropped tunnel leaves the daemon and
every rig on this host running while it reconnects, and it never falls back
to opening a port.

## What the gateway has to do

Two things the gateway in amika-mono does not do yet, which this client is
written to use as soon as it does.

**Authorize before the `101`.** The gateway accepts the WebSocket and then
authorizes, and it reports a refusal by aborting the socket. On the wire
that is indistinguishable from a dropped connection, so a daemon whose
credential was revoked cannot tell its operator why it is offline. It would
retry with ordinary transient backoff for ever.

`tunnel-dial.ts` already reads an HTTP status: 401, 403, 404, 410 and 426
stop the loop and produce an actionable message, and everything else is an
outage to wait out. Until the gateway sends one, the client counts
consecutive sessions that connected, served nothing and died, and raises
`suspect-credential` after five of them. That is a guess, and it says so.

**Put the connection id on the 101.** Spec 025's readiness result is host
id, connection id and public address. The connection id is minted by the
gateway's attachment directory, and the only channel the host has for it is
the handshake response, since the tunnel carries binary frames only and a
text control message is exactly what the gateway refuses. `dialTunnel`
reads `x-amika-connection-id` and `x-amika-host-url` when they are there,
and reports the attachment without them when they are not. The gateway
sends the connection id; it does not send a public URL today.

## Limits, and the one rule nothing enforces

`DEFAULT_LIMITS` mirrors the gateway's. The guard's limit at each end must
be at least the other end's initial stream window, and **nothing negotiates
this**: a host with a larger window trips the gateway's guard on its first
full-size frame and loses its tunnel. Amika owns both ends, so it is a
deployment rule. Keep `maxFrameBytes` here equal to the gateway's
`maxFrameBytes`, and check it when either moves.

`maxPayload` on the WebSocket is the only bound on an inbound WebSocket
message: `ws` assembles a whole message before the frame guard sees a byte
of it. `dialTunnel` sets it.

## Bundling

`ws` is CommonJS and calls `require("events")` as it loads. esbuild rewrites
that to a helper that throws `Dynamic require of "events" is not supported`
in ESM output, unless a real `require` is in scope, which the helper then
uses instead. `scripts/bundle.mjs` therefore carries a `createRequire`
banner, and `src/bundle.test.ts` bundles the tunnel on its own and runs it
with no `node_modules` to pin that. The daemon's own entry point does not
import the tunnel yet, so without that test the release bundle would break
on the day it does.

## Not here yet

- Rotation from the CLI. `TunnelClient.reattach` exists and the generation
  fence works; no command calls it. Until then a rotated credential is
  picked up on the next dial, because `resolveTunnelTarget` is read per
  attempt -- but nothing makes that attempt happen on demand.
- `--transport tunnel` as a _flag_. The transport is a setting, read from
  `transport` in the config or `AMIKA_HOSTD_TRANSPORT`, and `serve` and
  `up` both honour it. A flag would be a third place to say the same
  thing, and the one that disagreed would be the one in the operator's
  shell history rather than in the file.

## Enrolment

`amika-hostd setup` enrols a host whose transport is `tunnel`, after it
registers. One call to the control plane returns the credential, the
generation the gateway fences on, and the gateway's address; the
credential goes into the secret store and the rest into
`tunnel-enrolment.json` beside the config. The record deliberately does
not hold the credential, so a copied state directory does not carry one.

## Serving

`serve` and `up` start a tunnel instead of a listener when the transport
says so. `startTunnel` is the counterpart of `startServer`, and both
build the app and the upgrade handler through one `buildHandlers`, so a
rig reached down a tunnel answers the same routes under the same
authorization as one reached on a port.

A tunnel host binds nothing, so the readiness the daemon reports over IPC
carries no port. It carries the connection id the gateway named on the
`101`, where the gateway sends one, which is what matches this daemon
against the gateway's logs.
