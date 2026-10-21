# Service routes

```
user ──▶ amika server (control plane) ──▶ ngrok ──▶ amika-hostd ──▶ smolvm machine
         authenticates users,                        checks the key,
         sends the host key                          routes to the machine's service

browser ─────────────────────────────────▶ ngrok ──▶ amika-hostd ──▶ smolvm machine
         signed link from the amika server           checks the link
```

The amika server authenticates users itself and sends the host's secret key;
hostd checks the key and routes
`/v0beta1/rigs/<machine>/services/<name>/<path>` to that machine's service, over HTTP
(`fetch`) or a piped WebSocket upgrade.

Browsers, which cannot send a header on a navigation and must never hold the
host key, use a signed service link instead:
`/v0beta1/rigs/<machine>/service-links/<name>/<expiry>.<signature>/<path>`.
The `amika-hostd` provider mints it on the control plane and hostd verifies
it locally, both with `@amika/service-auth/credentials`: the signature is
an HMAC-SHA256 over the machine, service and expiry, under a key derived from
the host's secret key. A link lasts a day, and the control plane mints a new
one every twelve hours, so the oldest link it hands out still has twelve
hours left. hostd answers `401` for a bad or expired link, redirects one
missing its trailing slash to the full link, and otherwise forwards it as
the keyed route does. Regenerating the secret key invalidates every link;
removing a service makes its links `404`.

A link's path is its credential, and no single link can be revoked, so
`hardenServiceLinkResponse` wraps _every_ response on a link route: hostd's
own `401`, `404` and trailing-slash `308` as much as a proxied one, since
they carry the same URL and the last two are cacheable without asking. It
overrides four headers on the way back,
dropping `Service-Worker-Allowed` (every link shares the host's origin, so a
worker must stay inside its own link) and setting `Referrer-Policy:
no-referrer`, `Cache-Control: private, no-store` and `X-Robots-Tag:
noindex`. They are set rather than defaulted: the credential is hostd's, not
the service's, so a guest must not be able to opt into spreading it. All
four are stopgaps that last only as long as the link is the credential.

Most dev servers (Vite, Next.js) write root-relative URLs into their pages
(`/@vite/client`, `/_next/static/...`, `/api/...`), which leave the link and
carry no credential. So opening a link in a browser (`Sec-Fetch-Mode:
navigate`) also sets the link cookie, `__Host-amika-service-link`, naming the
link's machine, service and token (`@amika/service-auth/gateway`). A request
outside hostd's own paths (`/v0beta1/...`, `/api/v1/machines...`, `/health`)
that carries it is verified as the link would be and forwarded to that
service with its whole path as the guest path, HTTP and WebSocket upgrades
(hot reload) alike, and hardened like a link response.

- The cookie grants what the link grants, until the link's expiry
  (`Max-Age`), and is `HttpOnly; Secure; SameSite=Strict`. `SameSite` is by
  site, which a sibling subdomain shares, so hostd also accepts the cookie
  only on a request the browser marks `Sec-Fetch-Site: same-origin` (or
  `none`, for an address typed, a bookmark or a reload), HTTP and upgrades
  alike. hostd strips it before forwarding any request, on link routes too;
  a guest's own cookies pass through.
- It is never set for, nor routes to, `amikad`.
- A host is one origin, so a browser holds one link cookie per host: the
  link it opened last. A second service opened side by side takes over the
  first's root-relative requests; pages under a link path are unaffected.
- **A host is one trusted unit** (as KAPRO-1037 decided for links), and the
  cookie relies on it. A page from service A can `fetch("/api/...")` after
  the browser has opened service B on the same host: the request is
  same-origin and carries B's cookie, so A reads and acts on B as the user,
  without learning B's link. Services on one host already share the
  origin's cookies and storage. Isolating previews from each other needs an
  origin per preview (a subdomain each), which is KAPRO-1038's to solve;
  until then, keep code you do not trust off a host whose other previews
  you open.
- A service worker script requested from the root is refused (`404`): its
  scope would be the whole origin, every link on the host included.
- hostd's own paths never accept the cookie, so the machine API, keyed
  service routes and `/health` still need the key.
- It needs a hostname of hostd's own, at the root of an https origin on the
  default port, as an ngrok or cloudflared tunnel gives. Under a path
  (`https://example.com/hostd/`), root-relative URLs miss hostd entirely;
  over plain http, browsers drop the `Secure` cookie. Browsers scope cookies
  by host, not port, so hostd sets none on an explicit port
  (`preview.example:8443`) or an address that reaches the machine itself
  (`localhost`, `127.0.0.0/8`, `[::1]`, their IPv4-mapped forms,
  `0.0.0.0`): every other server on that host would receive the token and
  could replay it. `register-url` keeps such a URL, since links still work,
  but warns. hostd reads the host from `Host`, so a tunnel must pass it
  through unrewritten, as ngrok and cloudflared do by default.

- The key goes in `X-Amika-Hostd-Key`, since `Authorization` belongs to the
  guest (`amikad` checks SSH connect tokens with it). hostd never forwards
  the key.
- A caller without the key, such as `curl` or a script, may send a service
  token instead: `X-Amika-Authorization: Bearer <token>`. The control plane
  mints it (`signServiceToken` in `@amika/service-auth/credentials`) for
  one machine's one service, for at most a day: the same claim a link signs,
  under a second key derived from the secret key, so a link's token never
  works as a service token or the other way round. hostd refuses a token
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
  and opens nothing else: keyed service routes, links and the machine API
  still need their own credentials. amikad has no preview.
- With a session, a preview still answers only this origin's own requests
  (`Sec-Fetch-Site: same-origin` or `none`) and page loads another site
  starts, such as Amika opening it; anything else gets `403`. An upgrade
  must name this origin in `Origin`. Lax counts a sibling subdomain as the
  same site, and no CORS covers a WebSocket, so without this a page there
  could post to a preview or read its socket with the session.
- Opening a preview sets `__Host-amika-preview` (rig and service, no
  credential), so the page's root-relative URLs and upgrades reach the same
  service, under the same `Sec-Fetch-Site` rule as the link cookie, and only
  with the session too. A page load it routes renews it. Opening a preview
  ends the link cookie and opening a link ends the preview cookie, so the
  one opened last owns the root.
- The return path is resolved as a browser resolves `Location`, and anything
  that leaves the origin returns to `/`.
- Preview responses drop `Service-Worker-Allowed` and set `X-Robots-Tag:
noindex`, but keep the guest's own caching, made `private`: the URL is
  not a credential. A guest's CDN cache policies (`CDN-Cache-Control`,
  `Cloudflare-CDN-Cache-Control`, `Surrogate-Control`) are dropped there and
  on links, as a tunnel's CDN would read them first. hostd's login responses
  are `no-store`.
- hostd sets none of these cookies on a loopback address or an explicit
  port; `/__amika/login` answers `400` there. `GET /health` lists
  `browser-login` in `features`, and the `amika-hostd` provider hands out
  previews only to such a host whose URL is an https origin of its own,
  keeping service links everywhere else.
- hostd strips its own cookies from every forwarded request, and drops any
  `Set-Cookie` of a guest's under `__Host-amika-`, in a WebSocket
  handshake's answer as in any other response. That keeps a guest's
  server out of the login; a guest's page shares the origin, and its script
  could still set a cookie where none is held, as a host is one trusted
  unit.
