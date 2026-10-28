# Outbound tunnel

A host behind a home router has no way to be reached. Today an operator
solves that themselves: ngrok, a port forward, cloudflared, and then
`amika-hostd register-url` to tell Amika where the tunnel came out. That is
a second service to run, a second thing to pay for, and a URL that changes.

Tunnel mode removes it. The daemon binds nothing and **dials out** to an
Amika-run gateway over WSS. Each host's connection is held by its own relay
(a Cloudflare Durable Object), which opens one stream for each public
request it forwards. hostd serves each of those streams with the same Hono
app, the same authentication and the same upgrade handler a listening daemon
serves, so no route exists twice.

This document covers the client half, which lives in this repo. The relay
is in amika-mono (`js/gateway-cloudflare`). The wire
format is `amika.tunnel.v2`, and its code is `@amika/tunnel-protocol`
(`js/tunnel-protocol` in this repo), which both ends import.

## The pieces

`src/internal/` is flat, so the tunnel is a set of files rather than a
directory:

| File                    | What it owns                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `tunnel-dial.ts`        | The WSS handshake, and what the gateway's answer means         |
| `tunnel-session.ts`     | One live session: frames, the stream table, liveness, drain    |
| `tunnel-bridge.ts`      | One stream turned into a request to this daemon's own server   |
| `tunnel-socket-pair.ts` | Two connected sockets with nothing under them, for `node:http` |
| `tunnel-serving.ts`     | An `http.Server` with no listener, fed those sockets           |
| `tunnel-backoff.ts`     | How long to wait before dialling again                         |
| `tunnel-client.ts`      | The loop: dial, serve, decide what a disconnect meant          |
| `tunnel-target.ts`      | Where to attach, and what to prove it with                     |

## Decisions

### The credential is a host-scoped bearer token

hostd already keeps two secrets, and the tunnel uses neither.

- The **Amika API key** acts as the user across their whole organization.
  Spec 025 forbids reusing it, and `setup` already keeps it out of the
  daemon's environment.
- The **secret key** authorizes Amika's requests _into_ this daemon and
  signs service tokens and browser sessions. Attaching a host is the opposite direction and a
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

### A text ping that the relay answers without waking

The normal way a tunnel dies is a closed laptop lid. The socket stays in
`ESTABLISHED`, the kernel accepts writes, and no WebSocket or TCP event
reports anything. Only an unanswered round trip finds it.

So `TunnelSession` sends the text message `PING` (`amika.tunnel.v2.ping`)
every `KEEP_ALIVE_INTERVAL_MS` and ends the session when the text `PONG`
(`amika.tunnel.v2.pong`) does not
come back within `PING_TIMEOUT_MS`. The relay registers that pair with
Cloudflare's `setWebSocketAutoResponse`, so its runtime answers without
waking the relay: an idle host costs nothing, and the relay is not billed a
message for it. The relay also reads when it last answered, which is how it
tells a live host from one that went quiet without closing.

It is a text message, and not a WebSocket ping frame, for that reason: the
runtime can answer a message pair and report on it, and a protocol ping
reaches neither. `PING` and `PONG` are the only text messages on a tunnel.
Anything else in text ends the session as a peer that is not speaking the
protocol.

The strings are namespaced because the runtime's auto-response covers
every WebSocket the relay accepts, including the caller's side of a
relayed upgrade. A plain `ping` would be answered there by the runtime and
never reach the service, so an application heartbeat that uses that word
would break through the tunnel. A caller that sends exactly
`amika.tunnel.v2.ping` is still answered by the runtime; no application has
a reason to.

It pings on a fixed interval rather than only when the tunnel is idle.
Inbound traffic proves the relay can reach this host; it proves nothing
about the other direction, and a response that cannot be written is the
failure that matters. The same interval doubles as the idle keep-alive
NATs and load balancers need.

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

`TunnelSession.close()` stops accepting streams (a late `OPEN` is reset,
which the relay answers `502`), lets the requests in flight finish up to
`drainMs`, and then closes the WebSocket with 1001 "going away". The close
is what releases the attachment at the relay: a daemon that has gone does
not leave the relay forwarding into a socket nobody reads. Dropping the
connection instead loses every request sent before the relay presumes the
host gone.

A caller with upgraded connections -- SSH, the web terminal, a rig's service
WebSocket -- destroys those first. They are long-lived by design, so waiting
for them always runs the drain out to its bound. Listener-mode shutdown
makes the same distinction (`server.ts`).

Disconnecting is **not** shutdown. A dropped tunnel leaves the daemon and
every rig on this host running while it reconnects, and it never falls back
to opening a port.

### The relay sends heads, and Node parses HTTP at both ends

The relay runs in a Worker, which has no HTTP client that can write into a
custom stream and no parser this design wants to write. So it does not send
HTTP bytes. It sends a request head (method, target, header pairs) and
streams the body as `DATA`.

hostd turns that back into HTTP with Node's own code. Each stream gets a
socket pair (`tunnel-socket-pair.ts`): one end goes to the virtual server
exactly as a listener's accepted socket would, and `http.request` writes
the request into the other. The response is read back the same way and sent
as a response head and `DATA`. Chunked bodies, `Connection` rules and early
responses are Node's problem at both ends, and the daemon cannot tell a
tunnelled request from a listened one.

An upgrade uses a `ws` client on that end instead. A Worker cannot see the
bytes after a `101`, only WebSocket messages, so the relay accepts the
caller's WebSocket and this end opens its own against the upgrade handler.
Messages keep their text or binary type, and close codes cross both ways. A
refused upgrade is relayed as the plain response it is.

### Credit, so the relay never buffers a download

`DATA` moves under credit, per stream and per direction
(`@amika/tunnel-protocol/window`). This end grants credit back only once
Node has taken the bytes, and never sends a response body past what the
relay granted. The relay cannot push back on the caller it is streaming to,
so without credit a fast rig and a slow caller would buffer the download in
the relay's memory.

Relayed WebSocket messages carry no credit. Instead the bridge stops
reading the upstream WebSocket while the tunnel's own send buffer is over
4 MiB, which bounds this machine's side.

## What the relay does

**It authorizes before the `101`.** A refusal arrives as an HTTP status,
not an aborted socket, so a daemon whose credential was revoked can tell
its operator why it is offline instead of retrying for ever. The relay
answers `401` for a host the control plane rejects and `503` when it could
not ask. `tunnel-dial.ts` reads the status: 401, 403, 404, 410 and 426 stop
the loop and produce an actionable message, and everything else is an
outage to wait out. The gateway answers `426` to amika-hostd 0.5.x and
earlier, which dial `/v1/host-tunnel` with `amika.tunnel.v1`. As a
fallback, the client still counts consecutive sessions that connected,
served nothing and died, and raises `suspect-credential` after five of
them.

**It revokes by closing.** A renewal the control plane refuses closes the
socket (`4003`). The daemon redials, the relay answers `401`, and the loop
stops with that message.

**It names the connection on the `101`.** `dialTunnel` reads
`x-amika-connection-id`, and `x-amika-host-url` if it is ever sent, and
reports the attachment without them when they are not there.

## Limits come from one place

Nothing negotiates the frame size, the window or the stream limit, so both
ends import them from `@amika/tunnel-protocol` rather than keeping copies.
A change to the wire format is a new subprotocol and a new path, and the
gateway answers the old ones `426`: hosts and the relay ship separately,
and an incompatible change under the same name fails in silence.

A head is checked against the protocol's schema before it is sent, with
`isSendableRequestHead` at the relay and `isSendableResponseHead` here, so
the sender refuses one caller rather than send a frame the far end must
reject. A malformed frame ends the session, with one exception: an `OPEN`
whose header reads but whose head breaks the schema (`MalformedHeadError`)
is answered with a `RESET` for that stream alone. Its id still counts as
used. The relay builds heads from public requests, so one odd URL must not
be able to cut every stream on the host.

`maxPayload` on the WebSocket is the only bound on an inbound message: `ws`
assembles a whole message before the decoder sees a byte of it.
`dialTunnel` sets it to `MAX_FRAME_BYTES`.

## Bundling

`ws` is CommonJS and calls `require("events")` as it loads. esbuild rewrites
that to a helper that throws `Dynamic require of "events" is not supported`
in ESM output, unless a real `require` is in scope, which the helper then
uses instead. `scripts/bundle.mjs` therefore carries a `createRequire`
banner, and `src/bundle.test.ts` bundles the tunnel on its own and runs it
with no `node_modules` to pin that. The daemon's own entry point does not
import the tunnel yet, so without that test the release bundle would break
on the day it does.

## Enrolment

`amika-hostd up` enrols a host whose transport is `tunnel`, every time,
right after it registers. One call to the control plane returns the
credential, the generation the gateway fences on, and the gateway's
address; the credential goes into the secret store and the rest into
`tunnel-enrolment.json` beside the config the daemon loaded. The record
deliberately does not hold the credential, so a copied state directory
does not carry one.

Every `up`, not only when setup rotates the secret key: a host set up
fresh, or one whose operator kept its key, would otherwise never be
enrolled. Repeating it is harmless, because the control plane answers
with the credential it already holds. It is apart from setup's key
rotation for a second reason: a failed enrolment must never roll back a
secret key Amika has already taken.

The control plane enrols only for a person, so the API key must be a
user-scoped one; an organization-scoped key is refused with `403`.

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

### A rig named by its hostname

A browser reaches a rig's service at `<service>--<rig>.r.<org>.o.<zone>`.
That hostname never reaches this daemon on its own: the request goes to
the gateway's address. So the reverse proxy reads the rig and the service
out of it and signs them, and the gateway, having checked the signature,
writes them into the request head as `x-amika-rig` and `x-amika-service`.
It writes them after removing every `x-amika-` header the request arrived
with, so on a tunnel stream they can only be the gateway's. It also sends
the caller's own authority as `Host`.

The tunnel's server (`tunnel-rig-route.ts`) reads the two headers, removes
them, and records the rig and service beside the request in a `WeakMap`.
The app and the upgrade handler ask `namedRoute` for it and hand it to the
service-auth gateway as `GatewayRequest.named`. A header can be forged on a
listening socket; a `WeakMap` entry only the tunnel's server writes
cannot, so a listening daemon never names a request.

A named request is that service's whatever its path. `/v0beta1/rigs` on
`web--rig.r.org.o.<zone>` is the rig's own page, never this daemon's
machine list, so the app sends it to the service before any of its own
routes can match. The exceptions are `/__amika/login` and
`/__amika/callback`, which are how a browser logs in to that origin.

Who may have it is the gateway's to decide. At a name, that is a browser
session for that origin and nothing else:

- A page load without a session is sent to log in at the same origin and
  comes back to the same path. Amika checks the origin names a rig of the
  user's organization on this host, and posts the pass to that origin's
  callback.
- The host key and service tokens travel in `x-amika-` headers, which the
  reverse proxy and the gateway both drop from what a caller sends, so
  neither reaches a name. A scripted caller uses the service route.
- `amikad` takes no browser session. At its name it answers one request:
  its SSH WebSocket, `GET /v1/ssh-sessions` as an upgrade, without the
  host key, as at its service route. A tunnel host has no other address
  an SSH client can dial, and amikad checks the connect token before it
  accepts the socket. Everything else at `amikad--<rig>` is `404`.

The service is told its public address the way a reverse proxy tells an
app behind it: `X-Forwarded-Host` (the signed name) and `X-Forwarded-Proto:
https`, on plain requests and WebSocket handshakes alike, after any
forwarding headers the request arrived with are dropped. `Host` stays the
guest's local address on plain requests, so a dev server that accepts only
`localhost` keeps working; frameworks build redirects and check `Origin`
from the forwarded headers. A WebSocket handshake keeps the public `Host`,
which its server checks `Origin` against.

Each service is its own origin, so each logs in once, and no cookie has to
say which service the root belongs to. Every rig shares the zone, so a
sibling's page is the same site and the session goes with what it loads:
only the origin's own requests and page loads are let through, and a frame
or script another site loads is refused even with a session.

A request with neither header is the control plane calling this daemon's
API, and is left alone. One with only one of them, or a name that is not a
DNS label, is refused with `400`.
