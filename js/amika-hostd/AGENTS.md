# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It will manage
local VMs and make them accessible through the Amika control plane. The current
daemon serves `GET /health`, the versioned rig API under `/v0beta1/rigs`
(machines and their named services), the snapshots a host holds under
`/v0beta1/snapshots`, the Smol-compatible `/api/v1/machines`
API for older control planes, and
registers itself with the Amika control plane when started with `up`. `up`
also starts the `smolvm serve` process the API runs machines on (through the
`smol` sandbox provider; see [Machine runtime](docs/runtime.md#machine-runtime)),
and `down` stops both.

This file holds what every change needs: how to run and check the daemon, the
invariants that span files, and an index of the detail docs under `docs/`.
Read the doc for the area you are changing before changing it. The
conventions in [`js/AGENTS.md`](../AGENTS.md) apply here too, and
[README.md](README.md) is the operator-facing guide.

## Development

Run commands from the monorepo root:

```bash
pnpm install
export AMIKA_HOSTD_SECRET_KEY=$(openssl rand -hex 32)
pnpm --filter @amika/hostd dev
```

The server defaults to `127.0.0.1:3020` and refuses to start without a secret
key. No other external services or credentials are required to serve locally.

```bash
curl -H "Authorization: Bearer $AMIKA_HOSTD_SECRET_KEY" http://127.0.0.1:3020/health
pnpm --filter @amika/hostd build   # dist/bundle/amika-hostd.mjs
pnpm --filter @amika/hostd start   # node dist/bundle/amika-hostd.mjs up --fg
```

Plain `serve` (what `dev` runs) does not start smolvm; see
[Commands](docs/commands-and-registration.md#commands) for pointing it at one.
How the bundle is built and packaged for release is in
[Release bundle](docs/installation.md#release-bundle).

## Checks

```bash
pnpm --filter @amika/hostd formatcheck
pnpm --filter @amika/hostd typecheck
pnpm --filter @amika/hostd lint
pnpm --filter @amika/hostd test
```

The test command allows an empty suite until behavior is added. Use `format` to
apply formatting. `src/app.ts` defines routes without opening a socket;
`src/internal/server.ts` binds the listener and bounds shutdown.

## Invariants

Each of these is stated in full, with its reason, in the doc it links to.

**The HTTP API**

- **Every route requires a credential**, `/health` and unknown paths
  included, compared in constant time before the body limit. The caller's
  credential is never forwarded to the Smol runtime. See
  [Authentication](docs/api-and-auth.md#authentication).
- **Change a version's contract only in a new version.** `GET /health` lists
  the versions served and the features a control plane may rely on. See
  [API versions](docs/api-and-auth.md#api-versions).

**Credentials reaching hostd**

- **The host key never reaches a browser.** A browser uses a signed service
  link instead, minted on the control plane and verified locally, both with
  `@amika/service-auth/credentials`: an HMAC-SHA256 over the machine, service
  and expiry under a key derived from the secret key. Service tokens, the
  browser-login pass and the session sign under other derived keys, so no
  credential works as another. See [Service routes](docs/service-routes.md).
- **A link's path is its credential**, and no single link can be revoked, so
  `hardenServiceLinkResponse` wraps every response on a link route, hostd's
  own `401`, `404` and `308` included, and sets its headers rather than
  defaulting them.
- **hostd never forwards a credential it checks.** The key, the service-token
  header and hostd's own cookies are stripped before forwarding, for HTTP and
  WebSocket upgrades alike, and a guest's `Set-Cookie` under `__Host-amika-`
  is dropped.
- **Each credential opens only its own routes.** hostd's own paths never
  accept the link cookie, so the machine API, keyed service routes and
  `/health` still need the key; no link cookie or service token is set for or
  accepted for `amikad`; a browser session opens previews and nothing else.
  hostd sets no cookie on a loopback address or an explicit port.

**Secrets on the host**

- **One store, never mixed.** The API key and secret key live in the
  `keychain` store (the default) or the `file` store, chosen explicitly. A
  read never falls back from one store to the other, and hostd never falls
  back to files on its own. Values reach `security` and `secret-tool` on
  stdin, never in the process list. See
  [Secret storage](docs/setup-and-secrets.md#secret-storage).
- **The daemon holds only the secret key, and never reads the store.** `up`
  reads the secrets and hands the secret key over IPC; neither secret goes in
  the daemon's environment. smolvm, rigs, the snapshot pack subprocess and
  the smolvm version check never see either secret.
- **Secrets stay out of files and messages they do not belong in.** The API
  key never comes from TOML. Config and secret files are replaced atomically
  with mode `0600` (`src/internal/private-file.ts`). Never include a secret or
  file contents in a `ConfigError` message, nor the API key or secret in a
  registration error. See [Configuration](docs/configuration.md).
- **Registration never changes a stored secret.** Only setup's regenerate
  path sends a new secret key to Amika, after storing it locally. See
  [Registration](docs/commands-and-registration.md#registration).
- **Requests to Amika and to smolvm refuse redirects**, so credentials, exec
  bodies and uploaded files are never resent to another origin. smolvm's
  error reason is withheld for exec and redacted of a create's env values.
  See [Machine runtime](docs/runtime.md#machine-runtime).

**Runtime**

- **smolvm listens only on loopback**: its API has no authentication. It is
  never killed outright, and `down` signals a pid only once `/proc` or `ps`
  confirms its program. See [smolvm](docs/runtime.md#smolvm).
- **Pre-pull deletes only the machines it recorded**, and hides only hostd's
  own from the machine list. See
  [Image cache](docs/configuration.md#image-cache).
- **`resolveSource` checks `[preset_images]`, then the snapshot store, then
  the full-reference passthrough**, so an unconfigured preset never falls
  through to a Docker Hub pull. A snapshot name never reaches the filesystem,
  and a rig being captured answers `409` to every route but reading it. See
  [Snapshots](docs/snapshots.md).

**Kept in step by tests or by hand**

- `config.example.toml` with the config schema (`config.test.ts`) and with
  `DEFAULT_SIZES` and `DEFAULT_PRESET_IMAGES` (`setup.test.ts`).
- The `setup --skill` text with the CLI (`setup-skill.test.ts`); options on
  `amika` CLI commands it names are mirrored by hand.
- A blank environment variable sets nothing; ask which variable sets a
  setting through `envName`.
- The bundle runs under plain `node` with no `node_modules`
  (`src/bundle.test.ts`).

## Detail docs

`src/internal/` is flat, so the detail lives in `docs/` by area:

- [docs/installation.md](docs/installation.md) — read when changing
  `install-amika-hostd.sh` (install, `--uninstall`) or the release bundle
  (`scripts/bundle.mjs`, `scripts/package-release.sh`).
- [docs/commands-and-registration.md](docs/commands-and-registration.md) —
  read when changing the CLI (`src/index.ts`, `cli.ts`, `daemon.ts`), how
  `up`, `serve` and `down` start and stop, registration with Amika
  (`amika-api.ts`), `register-url`, or the pidfile.
- [docs/setup-and-secrets.md](docs/setup-and-secrets.md) — read when changing
  `amika-hostd setup` (`setup.ts`, `setup-skill.ts`), secret-key regeneration,
  or where secrets are kept (`credentials.ts`).
- [docs/configuration.md](docs/configuration.md) — read when changing a
  setting (`config.ts`, `config.example.toml`), preset images, or the image
  cache and pre-pull (`prepull.ts`).
- [docs/runtime.md](docs/runtime.md) — read when changing how smolvm is run
  (`smolvm-serve.ts`) or the machine API on top of it (`machine-runtime.ts`).
- [docs/api-and-auth.md](docs/api-and-auth.md) — read when adding or
  changing a route, a `/health` feature, or how a request is authenticated
  (`src/app.ts`, `auth.ts`).
- [docs/service-routes.md](docs/service-routes.md) — read when changing
  service routing, signed links, service tokens, the link cookie, previews or
  browser login (`src/app.ts`, `services.ts`, `service-registry.ts`,
  `@amika/service-auth`).
- [docs/snapshots.md](docs/snapshots.md) — read when changing snapshot capture
  or storage (`snapshots.ts`, `snapshot-store.ts`) or how a create resolves
  its source (`requests.ts`).
