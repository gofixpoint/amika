# Service routes

```
user ──▶ amika server (control plane) ──▶ ngrok ──▶ amika-hostd ──▶ smolvm machine
         authenticates users,                        checks the key,
         sends the host key                          routes to the machine's service

browser ─────────────────────────────────▶ ngrok ──▶ amika-hostd ──▶ smolvm machine
         preview URL from the amika server           checks the browser's session
                                                     (logged in through Amika)
```

The amika server authenticates users itself and sends the host's secret key;
hostd checks the key and routes
`/v0beta1/rigs/<machine>/services/<name>/<path>` to that machine's service, over HTTP
(`fetch`) or a piped WebSocket upgrade.

Browsers, which cannot send a header on a navigation and must never hold the
host key, open a preview instead (see
[Previews and browser login](#previews-and-browser-login)). Signed service
links (`/v0beta1/rigs/<machine>/service-links/...`), which put a credential in
the URL, are retired: hostd no longer serves them, and a request for one
needs the key like any other path hostd does not serve.

- The key goes in `X-Amika-Hostd-Key`, since `Authorization` belongs to the
  guest (`amikad` checks SSH connect tokens with it). hostd never forwards
  the key.
- A caller without the key, such as `curl` or a script, may send a service
  token instead: `X-Amika-Authorization: Bearer <token>`. The control plane
  mints it (`signServiceToken` in `@amika/service-auth/credentials`) for
  one machine's one service, for at most a day: an HMAC-SHA256 over the
  machine, service and expiry, under a key derived from the secret key for
  tokens alone. Regenerating the secret key invalidates every token. hostd
  refuses a token
  that claims to live longer, never accepts one for `amikad`, and strips
  the header before forwarding, HTTP and upgrades alike. A `401` on a
  service route carries a `hint` saying where a token goes, except for
  `amikad`; it names no CLI command until the CLI has one. `GET /health` lists `service-tokens` in `features` so a control
  plane knows the host takes them (KAPRO-1038).
- One request needs no key: the SSH WebSocket that `amika sandbox ssh`
  opens, exactly `GET .../services/amikad/v1/ssh-sessions` as an upgrade,
  to a running rig whose `amikad` is on port 60999. `amikad` checks the
  connect token the control plane gave the CLI; the key never leaves the
  control plane. Everything else still needs the key.
- Create takes `services: [{ name, port }]`. The `smol` provider publishes
  each port on a host loopback port it picks, and hostd keeps each machine's
  name-to-port map in `services.json` (`src/internal/service-registry.ts`),
  since smolvm stores no names.
  `PUT /v0beta1/rigs/<name>/services` replaces the map later (the
  provider's `syncRoutes`), on ports published at create.

## Previews and browser login

With Amika's URL configured (`api_url`, which hostd always has),
hostd also serves previews: `/v0beta1/rigs/<machine>/previews/<name>/<path>`,
an address with no credential in it (KAPRO-1038). A browser proves itself
with a session cookie instead, set after Amika vouched for its user
(`@amika/service-auth/gateway`; the credentials are in
`@amika/service-auth/credentials`):

1. A page load on a preview without a session is redirected to
   `/__amika/login?return=<path>`, which keeps a random state and the path in
   `__Host-amika-login` (`SameSite=None`, 10 minutes) and redirects to
   `<api_url>/hosts/authorize?origin=<this host's origin>&state=<state>`.
   A page load a preview cookie routes (a root-relative URL) does the same,
   returning to its guest path through the preview's own: the Strict preview
   cookie is not sent on the redirect back from Amika's site, and opening
   the preview renews it. Anything other than a page load gets `401`.
2. Amika checks the user is signed in and that one of their org's hosts is
   registered at that origin, then form-posts a login pass to that host's
   registered URL, `/__amika/callback`. The pass names the origin, state and
   user, lives a minute, and is signed under a key derived from the secret
   key. Either clock may be up to five minutes ahead of the other.
3. hostd checks the pass against the state cookie, answers each state once,
   sets `__Host-amika-session` (`SameSite=Lax`, a day, signed under another
   derived key), and redirects to the path.

- Lax, not Strict: a preview is opened from Amika, another site, and a
  Strict session would send every such click back to log in.
- A session covers every preview on the host, as a host is one trusted unit,
  and opens nothing else: keyed service routes and the machine API still
  need their own credentials. amikad has no preview.
- With a session, a preview still answers only this origin's own requests
  (`Sec-Fetch-Site: same-origin` or `none`) and page loads another site
  starts, such as Amika opening it; anything else gets `403`. An upgrade
  must name this origin in `Origin`. Lax counts a sibling subdomain as the
  same site, and no CORS covers a WebSocket, so without this a page there
  could post to a preview or read its socket with the session.
- Most dev servers (Vite, Next.js) write root-relative URLs into their pages
  (`/@vite/client`, `/_next/static/...`, `/api/...`), which leave the
  preview's path. So opening a preview sets `__Host-amika-preview` (rig and
  service, no credential), and a request outside hostd's own paths
  (`/v0beta1/...`, `/api/v1/machines...`, `/health`) that carries it goes to
  that service with its whole path as the guest path, HTTP and WebSocket
  upgrades (hot reload) alike, with the session too. hostd accepts it only
  on a request the browser marks `Sec-Fetch-Site: same-origin` (or `none`,
  for an address typed, a bookmark or a reload): `SameSite` is by site,
  which a sibling subdomain shares. A page load it routes renews it.
  Opening a preview also ends a retired link's cookie
  (`__Host-amika-service-link`), which hostd still strips before forwarding.
- A host is one origin, so a browser holds one preview cookie per host: the
  preview it opened last. A second service opened side by side takes over
  the first's root-relative requests; pages under a preview path are
  unaffected.
- **A host is one trusted unit**, and the preview cookie relies on it. A
  page from service A can `fetch("/api/...")` after the browser has opened
  service B on the same host: the request is same-origin and carries the
  session and B's preview cookie, so A reads and acts on B as the user.
  Services on one host already share the origin's cookies and storage.
  Isolating previews from each other needs an origin per preview, which a
  tunnel host's named rig hostnames (`<service>--<rig>.r.<org>.o.<zone>`)
  give; until then, keep code you do not trust off a host whose other
  previews you open.
- A service worker script requested from the root through the preview
  cookie is refused (`404`): its scope would be the whole origin, every
  preview on the host included.
- The return path is resolved as a browser resolves `Location`, and anything
  that leaves the origin returns to `/`.
- Preview responses drop `Service-Worker-Allowed` and set `X-Robots-Tag:
noindex`, but keep the guest's own caching, made `private`: the URL is
  not a credential. A guest's CDN cache policies (`CDN-Cache-Control`,
  `Cloudflare-CDN-Cache-Control`, `Surrogate-Control`) are dropped there and
  as a tunnel's CDN would read them first. hostd's login responses are
  `no-store`.
- Previews need a hostname of hostd's own, at the root of an https origin on
  the default port, as an ngrok or cloudflared tunnel gives. Under a path
  (`https://example.com/hostd/`), root-relative URLs miss hostd entirely;
  over plain http, browsers drop the `Secure` cookies. Browsers scope
  cookies by host, not port, so hostd sets none on an explicit port
  (`preview.example:8443`) or an address that reaches the machine itself
  (`localhost`, `127.0.0.0/8`, `[::1]`, their IPv4-mapped forms,
  `0.0.0.0`), where every other server on that host would receive them.
  `/__amika/login` answers `400` there, telling the browser to register an
  https URL with `register-url` and upgrade amika-hostd. `register-url` keeps
  such a URL, since service tokens still work, but warns. hostd reads the
  host from `Host`, so a tunnel must pass it through unrewritten, as ngrok
  and cloudflared do by default.
- `GET /health` lists `browser-login` in `features`. The `amika-hostd`
  provider hands every service but amikad its preview URL on every host,
  without asking: a host that cannot serve one answers it with the `400`
  above (or, from a hostd too old to know previews, a `401`), and serves it
  as soon as it is fixed.
- hostd strips its own cookies from every forwarded request, and drops any
  `Set-Cookie` of a guest's under `__Host-amika-`, in a WebSocket
  handshake's answer as in any other response. That keeps a guest's
  server out of the login; a guest's page shares the origin, and its script
  could still set a cookie where none is held, as a host is one trusted
  unit.

## Access modes and the Host header at a name

A service reached at its own name (`<service>--<rig>.r.<org>.o.<zone>`,
named by the tunnel; see `tunnel-rig-route.ts`) is what the control plane
said it is when it created or replaced the rig's services. Two fields of
each service say so, and `services.json` keeps them with the port
(`service-registry.ts`); `GET /health` lists `service-access` on a daemon
that takes them.

- `auth`: who Amika admits at the name. `organization` (the default) is the
  browser login above, which every member of the organization passes.
  `owner` is that login, and then the session's user must be the rig's
  `owner`, which the create body names beside the services (a rig's never
  changes, so a replace does not); a rig without one admits nobody this way, and a member who is not the owner
  gets a `403` that says so. `public` is no check at all: every request
  reaches the service as the caller sent it, its `Authorization`, its CORS
  preflight and its WebSocket upgrade included, because an app on another
  origin (a desktop app, a hosted web app) carries no session of ours and
  does its own login. A public service is a service, not a preview, so its
  answers are not hardened as one. amikad takes neither field: it keeps its
  own rules at its name, and a body that sets one for it is refused.
- `preserve_host`: what the service sees in `Host`. Off (the default), the
  loopback address hostd dials, `127.0.0.1:<port>`, as a reverse proxy
  leaves it, so a dev server that accepts only `localhost` keeps answering;
  the public name is in `X-Forwarded-Host`. On, the public name itself, for
  an app that compares `Origin` with `Host` before it acts or builds its
  links from `Host`. The name is always the one the gateway signed, never a
  caller's. An HTTP request and a WebSocket upgrade give the same answer
  (`guest-host.ts`); before this field, an upgrade kept the public name
  while an HTTP request got the loopback address.

The decision stays in `@amika/service-auth/gateway` (`authorizeNamed`):
hostd hands it what the registry recorded (`namedService`), and it answers
as for any named request.
