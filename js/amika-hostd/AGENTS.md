# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It will manage
local VMs and make them accessible through the Amika control plane. The current
daemon serves `GET /health`, the versioned rig API under `/v0beta1/rigs`
(machines and their named services), the Smol-compatible `/api/v1/machines`
API for older control planes, and
registers itself with the Amika control plane when started with `up`. `up`
also starts the `smolvm serve` process the API forwards to, and `down` stops
both.

## Installation

On a host, install the released daemon with `install-amika-hostd.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
```

It downloads `amika-hostd_<version>.tar.gz` from the `amika-hostd@v<version>`
GitHub release, verifies it against `checksums.txt`, and installs:

- the bundle and `config.example.toml` into `$XDG_DATA_HOME/amika-hostd`
  (default `~/.local/share/amika-hostd`; override with `AMIKA_HOSTD_HOME`),
  with an `amika-hostd` launcher on `AMIKA_INSTALL_DIR` (default
  `/usr/local/bin`) that pins the node it runs on;
- Node.js: the system `node` if it is 22 or newer, otherwise the official
  Node.js LTS binary (24.21.0, `AMIKA_HOSTD_NODE_VERSION`), verified against
  `SHASUMS256.txt`, into `node/` in that same directory (the system node is
  never touched);
- smolvm, through its official installer, unless `smolvm` is on `PATH` or in
  `~/.smolvm` or `~/.local/bin`. Pin it with `--smolvm-version`
  (`SMOLVM_VERSION`) or skip it with `--skip-smolvm`;
- the machine engine the daemon is moving to: the `smolmachines` SDK
  (smolvm's engine, embedded) the release carries, into `node_modules/` in
  that same directory, plus this platform's engine package
  (`smolmachines-linux-x64-gnu`, `-linux-arm64-gnu` or `-darwin-arm64`:
  native addon, boot helper, hypervisor libraries and guest rootfs, over
  100 MB) downloaded from npm (`AMIKA_HOSTD_NPM_REGISTRY`) and verified
  against the release's `engines.sha256`. Any other platform, or Linux with a
  C library other than glibc 2.34+, fails before anything is downloaded;
- a config: `config.example.toml` copied to the user config path below, with
  `hostname` set to this machine's lowercased `hostname` (left commented when
  it isn't a valid hostname), unless a config already exists there or in
  `/etc`. It is never overwritten, and it holds no secret: `amika-hostd setup`
  keeps the secrets (see [Secret storage](#secret-storage)).

Its closing steps point the operator at `amika-hostd setup`, then
`amika-hostd up` (which runs setup itself if it was skipped).

On Linux it warns, without failing, when `/dev/kvm` is missing or not
accessible. `--dry-run` prints the plan. Nothing else needs to run alongside
the daemon: `amika-hostd up` starts smolvm itself (see [smolvm](#smolvm)).

The daemon is one ESM file, built by `pnpm --filter @amika/hostd bundle`
(`scripts/bundle.mjs`, esbuild with every npm dependency inlined except
`smolmachines`, which finds its native files on disk beside its own and so is
installed in `node_modules`), so it runs under plain `node` with no
`node_modules`; `src/bundle.test.ts` checks that. `scripts/package-release.sh
<version> [out-dir]` wraps the bundle, the example config, the `smolmachines`
package at the exact version `package.json` pins, and `engines.sha256` (each
platform's engine package, fetched with `npm pack`) in one tarball for every
platform, and writes `checksums.txt`. The Release workflow
runs it for an `amika-hostd@v*` tag. To test the installer against a local
build, point `AMIKA_RELEASE_URL` at that directory, with a temporary `HOME`
and `AMIKA_INSTALL_DIR`:

```bash
js/amika-hostd/scripts/package-release.sh 0.1.0 /tmp/hostd-release
HOME=/tmp/hostd-home AMIKA_INSTALL_DIR=/tmp/hostd-bin \
  AMIKA_RELEASE_URL=file:///tmp/hostd-release \
  sh install-amika-hostd.sh
```

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
pnpm --filter @amika/hostd build
pnpm --filter @amika/hostd start   # node dist/index.js up --fg
```

## Commands

`src/index.ts` is the `amika-hostd` bin; `src/internal/cli.ts` parses commands
with `node:util` `parseArgs` and takes every side effect as a dependency.

- `amika-hostd setup` asks for the hostname and API key, generates the secret
  key, and writes them (see [Setup](#setup)).
- `amika-hostd up [--port N] [--host H]` starts the daemon in the background:
  it re-runs itself as `serve --smolvm` with `detached: true`, appends output, each line
  timestamped, to `$XDG_STATE_HOME/amika-hostd/log/amika-hostd.log` (else
  `$HOME/.local/state/...`), and waits for the child's IPC `ready` message, so startup failures print in the
  caller's terminal. Only the operator's own flags are forwarded; the child
  inherits the environment and re-reads the TOML file.
- `amika-hostd up --fg` and `amika-hostd serve` run in the foreground until
  `SIGINT` or `SIGTERM`. Shutdown waits up to 5 seconds for in-flight requests,
  then drops the rest, and the process exits a second later even if a request
  to the Smol runtime is still pending, so a slow client or runtime cannot keep
  the daemon alive. A daemon running smolvm first waits up to 60s more for it
  to stop (see [smolvm](#smolvm)). If the launching `up` exits before the
  child is ready, the child shuts down too.
  Only `up` registers with Amika; `serve` does not. `up` (either way) and
  `serve --smolvm` also run smolvm; plain `serve` does not, for development.
  Plain `serve` forwards to `SMOL_API_URL`, else to a fixed
  `http://127.0.0.1:23020` (it does no port scan), so run a hand-started
  smolvm there with `smolvm serve start --listen 127.0.0.1:23020` or point
  `SMOL_API_URL` at it.
- `amika-hostd down` sends `SIGTERM` to the daemon named by the pidfile and
  waits for it to exit, which includes stopping smolvm. It needs no
  configuration.
- `amika-hostd register-url <url>` records the host's public URL and exits.

## Setup

`src/internal/setup.ts` runs `amika-hostd setup`, which needs a terminal. It
edits the TOML file `up` reads (the first that exists, else the user path),
and keeps the secrets in the secret store (see [Secret storage](#secret-storage)).
It opens the store first, so on a machine with no keychain and no
`secret_store = "file"` it refuses before asking anything.

It asks for the hostname, defaulting to the configured one, or else the
machine's own hostname made valid (lowercased, `.local` dropped, other
characters turned into `-`), re-asking until it is valid. When the host has no
secret key it generates one (`randomBytes(32)`, hex), unless the environment
sets one, which is saved instead (Amika may already know it). An existing
secret key is kept. Then it asks for the Amika API key, with input hidden, or
on a rerun whether to replace the stored one; an API key in the environment is
used instead, and setup does not ask.

It then writes `hostname` in place (a live line, bare or quoted, else the
commented `# hostname = ...` one; otherwise above the first table), keeping
everything else in the file. With the file store it writes `secret_key` the
same way; with the keychain it removes any `secret_key` line instead, moving
that secret into the keychain if the keychain has none (the keychain's own
item wins otherwise). A `secret_key` too short to use, such as an old
example's `REPLACE_ME`, counts as unset. A config written from scratch also
gets the example's default `[sizes]` and `[preset_images]` (`DEFAULT_SIZES`
and `DEFAULT_PRESET_IMAGES`, which `setup.test.ts` keeps in step with
`config.example.toml`). It prints the result and where to edit it. The new
contents are parsed before anything is written, and the file is replaced
atomically with mode `0600` (`src/internal/private-file.ts`). The secrets are
stored first, so a secret that cannot be stored (a locked keychain, say)
leaves the config untouched.

`up` runs setup first whenever the hostname, secret key or API key is
missing, or a `secret_key` in the file needs moving into the keychain, and it
has a terminal; without one it fails, naming `setup`. Like setup, it reads a
`secret_key` too short to use as missing, so a hand-copied old example gets
set up rather than rejected; other commands still reject it. Ctrl-C at a
question exits 130 and changes nothing.

### Secret storage

hostd has two secrets: the Amika API key, which `up` and `register-url` use
to call Amika, and the secret key, which Amika presents on every request to
the daemon. `src/internal/credentials.ts` keeps both in one of two stores,
chosen by `secret_store` in the TOML file or `AMIKA_HOSTD_SECRET_STORE`:

- **`keychain`** (the default): both are items in the system keychain. On a
  machine where amika-hostd supports no keychain, every command that needs a
  secret refuses, naming `secret_store = "file"`; it never falls back to a
  file on its own.
- **`file`**, chosen explicitly: the API key in
  `$XDG_CONFIG_HOME/amika-hostd/api-key` and the secret key as `secret_key` in
  the TOML file, both mode `0600`. That is how `gh` and Docker keep
  credentials without a keyring, and how WireGuard and `sshd` keep their keys.

The two are never mixed: a read never falls back from one store to the other,
so a key left in one cannot shadow a newer one in the other. The environment
(`AMIKA_HOSTD_API_KEY`, `AMIKA_HOSTD_SECRET_KEY`) overrides either store.

A person always starts the daemon, with `up`, so `up` reads the secrets (an
unlock prompt can reach them) and hands the secret key to the background
daemon over the IPC channel it already uses to wait for "ready"
(`receiveSecretKey` in `src/internal/daemon.ts`, behind the internal
`serve --secret-key-from-up`). Neither secret goes in the daemon's
environment, and the daemon never reads the store; smolvm and rigs get
neither. `serve` run by hand reads the secret key from the store itself, and
never the API key.

## Registration

Before starting the daemon, `up` calls `POST /api/v0beta1/hosts` on the Amika
API (`src/internal/amika-api.ts`) with `Authorization: Bearer <API key>` and a
body of `hostname`, `secret` and `sizes`. The endpoint is
idempotent by hostname: `201` creates the host, `200` returns the existing host
and leaves its stored secret and sizes unchanged. Changing the local secret
therefore never rotates it in Amika; changing the hostname registers a new
host. On `200`, `up` then sends `PUT /api/v0beta1/hosts/{id}` with the
configured `sizes`, so edits to the `[sizes]` tables reach
Amika on the next `up` (or `register-url`). The config is the source of truth:
the PUT replaces the host's stored sizes, so a config with no `[sizes]` tables
clears them. Any other status, a network error,
or a 30s timeout aborts `up` before a daemon starts, with a message that never
includes the API key or secret. `401`/`403` from the sign-in check in front of the API carry `{ error }` rather
than `{ error_code, message }`, and that reason is kept. Redirects are refused
so credentials cannot be resent to another origin, and the error says so. On
`200`, `up` warns that Amika kept the stored secret, since a changed local
secret would make Amika's requests fail. The background daemon is spawned
without `AMIKA_API_KEY`/`AMIKA_HOSTD_API_KEY`: it only serves, so the
background daemon never holds the API key. `up` checks the pidfile before
registering, so a second `up` fails without calling Amika.

Registration is complete once Amika knows the host's internet-facing URL (an
ngrok or Cloudflare Tunnel URL, for example). `up` runs in this order: resolve
config, register the hostname and secret, start the daemon (background, or
`--fg`), then complete registration. If the host has no URL and stdin and
stdout are both terminals, `up` asks the operator to expose the now-running
daemon and enter its public URL, re-asking on an invalid URL. A blank answer or
end of input (Ctrl-D) skips it. Ctrl-C exits 130: a background daemon keeps
running, while `--fg` stops. A failed save is reported and the daemon keeps
running (`up` exits 1 in the background). Without a terminal it prints how to
finish instead of blocking. If the host already has a URL, `up` reminds the
operator that Amika expects to reach it there.

`amika-hostd register-url <url>` sets the URL from the same configuration as
`up`: it registers idempotently to learn the host's id, then sends
`PUT /api/v0beta1/hosts/{id}` with the hostname and URL and no secret, so the
stored secret is kept. Only absolute http(s) URLs without credentials are
accepted; a bare origin is normalized without its trailing slash, and a path is
kept.

Every run claims `amika-hostd.pid` in that state directory, atomically, and refuses to
start while it names a live daemon. The daemon sets `process.title` to
`amika-hostd`; where `/proc` exists, a pidfile naming any other process is
treated as stale, since the pidfile outlives reboots and pids are reused. An
empty `--host` is rejected, since it would bind every interface. Stop a
background daemon with `amika-hostd down`. `build` uses
`tsconfig.build.json`, which leaves tests out of `dist/`.

## smolvm

`src/internal/smolvm-serve.ts` runs smolvm for `up` and `serve --smolvm`, so
the daemon and the runtime it forwards to start and stop together, and a host
is left as it was before `up`:

1. Before spawning smolvm, it refuses to start if a smolvm from an earlier
   run is still alive (`smolvm.pid`, next to the daemon's pidfile). Files an
   earlier run left naming a pid that has exited are removed.
2. It finds `smolvm` on `PATH`, else where the smolvm installer puts it
   (`~/.smolvm/smolvm` or `~/.local/bin/smolvm`).
3. It picks a port and runs `smolvm serve start --listen <host:port>`.
   smolvm's own default is a Unix socket, so the address is always passed.
   `SMOL_API_URL` must be a plain `http://<IP address>[:port]` (port 80 if
   omitted), since `--listen` takes no hostnames such as `localhost`. The
   address must be loopback (`127.0.0.0/8` or `[::1]`): smolvm's API has no
   authentication, so listening anywhere else would expose it without
   amika-hostd's bearer check.

   A port is free when a plain TCP connect is refused, since the holder may not
   speak HTTP (an editor's language server, say). With `SMOL_API_URL` set, it
   uses that port or fails naming it. Unset, it starts at 23020 and moves to
   the next port while the port is held, or while smolvm exits with
   `Address already in use` (another program won the race), giving up only once
   every port up to 65535 is taken. A shutdown signal stops the scan. It never
   shares a port, and it refuses to start at all when a held port it tries, or
   `127.0.0.1:8080` (where smolvm's docs run it by hand), is a smolvm (both
   `/health` and `/api/v1/machines` answer 2xx): a smolvm it did not start
   would expose unrelated VMs, and is not the daemon's to stop or drain. A
   smolvm elsewhere (another port the scan never reaches, or a Unix socket)
   goes unnoticed. The daemon forwards to the chosen URL, which is also written
   to `smolvm.url` beside `smolvm.pid` while smolvm runs.

   smolvm gets its own process group, so Ctrl-C on `up --fg` reaches only
   the daemon; its output goes to `log/smolvm.log`, with `NO_COLOR=1` so the
   log carries no ANSI color codes; and it never sees the API key or secret
   key.

4. The daemon listens only once smolvm answers `/health` (30s at most) and is
   still running half a second later (a program that won the race for the port
   answers too, until smolvm fails to bind), so the background `up` reports a
   smolvm that fails to start. A shutdown signal while it waits stops smolvm
   and exits without listening.
5. On shutdown the daemon stops listening first, then sends smolvm `SIGTERM`
   and waits up to 60s. smolvm is started with `SMOLVM_DRAIN_ON_SHUTDOWN=1`,
   so it stops every machine cleanly (disks are kept; nothing is deleted)
   instead of leaving them running, which is its default. It is never killed
   outright: if it is still stopping machines after 60s, the daemon exits and
   `down` goes on waiting for it.
6. If smolvm exits on its own, the daemon stops too, with exit code 1, rather
   than answer every request with a `502`.

`down` stops the daemon, then any smolvm a daemon left behind (one killed with
`SIGKILL`, or that timed out stopping it). Both pidfiles are acted on, not
only read, so `down` signals a pid only when `/proc` or `ps` confirms its
program: `amika-hostd` (the daemon's title) for the daemon, and `smolvm` or
`smolvm-bin` (the binary the `smolvm` launcher `exec`s) for smolvm. A daemon
pidfile naming a live process that is not confirmed is left alone, and `down`
says to remove it if it is stale, as `up` does. A `smolvm.pid` and
`smolvm.url` naming a pid that has exited are removed.

## Configuration

`src/internal/config.ts` resolves every setting in one place. Each setting takes
the first source that sets it: CLI flag, then environment, then TOML file.

| Setting      | Flag     | Environment                                   | TOML                           | Default                 |
| ------------ | -------- | --------------------------------------------- | ------------------------------ | ----------------------- |
| API key      |          | `AMIKA_HOSTD_API_KEY` / `AMIKA_API_KEY`       | (rejected)                     | in the secret store     |
| API URL      |          | `AMIKA_HOSTD_API_URL` / `AMIKA_API_URL`       | `api_url`                      | `https://app.amika.dev` |
| Hostname     |          | `AMIKA_HOSTD_HOSTNAME`                        | `hostname`                     |                         |
| Secret key   |          | `AMIKA_HOSTD_SECRET_KEY` / `AMIKA_SECRET_KEY` | `secret_key` (file store only) | in the secret store     |
| Secret store |          | `AMIKA_HOSTD_SECRET_STORE`                    | `secret_store`                 | `keychain`              |
| Bind host    | `--host` | `AMIKA_HOSTD_HOST`                            | `host`                         | `127.0.0.1`             |
| Port         | `--port` | `AMIKA_HOSTD_PORT`                            | `port`                         | `3020`                  |

Setting both names of an aliased pair to different values is an error, never a
silent pick. A blank variable (empty, or only whitespace) sets nothing; code
that asks which variable sets a setting uses `envName`, which applies the same
rule, rather than testing `env[name]` itself. The API key never comes from TOML: a TOML `api_key` fails
startup. Without one in the environment, the key `setup` stored is used (see
[Secret storage](#secret-storage)).
The hostname must be a lowercase RFC 1123 hostname, the rule the control plane
enforces, so a bad one fails locally instead of at registration.
The TOML file is the first of `$XDG_CONFIG_HOME/amika-hostd/config.toml`
(default `~/.config/...`) and `/etc/amika-hostd/config.toml` that exists; the
two are not merged, and unknown keys are rejected. `SMOL_API_URL` (where `up`
and `serve --smolvm` start smolvm, by default the first free port from
`http://127.0.0.1:23020`, see [smolvm](#smolvm); plain `serve` forwards to a
fixed `http://127.0.0.1:23020`) and `SMOL_REQUEST_TIMEOUT_MS` remain
environment-only. `config.example.toml`
is the template the installer seeds: every setting with a default is a live
line, and only `hostname` and `secret_store` are commented. It holds no
`secret_key`, since the secrets live in the keychain by default. Keep its comments short. `config.test.ts`
resolves it as seeded, so keep it in step with the schema. Never include a secret or
file contents in a `ConfigError` message: operators see it verbatim.

### Images

`[preset_images]` maps a preset name to the full OCI reference this host boots for it,
so the host, not Amika, pins the version:

```toml
[preset_images]
amika-coder = "ghcr.io/gofixpoint/amika-coder:latest"
amika-coder-plus-docker = "ghcr.io/gofixpoint/amika-coder-plus-docker:latest"
```

The seeded config tracks `:latest`, which every image release moves. A host
that needs a fixed version pins the release's 12-character commit SHA instead.
Because `:latest` is a moving tag, smolvm's in-VM image cache can keep serving
the previously pulled digest, so an upgrade is not guaranteed to take effect
until that cache is cleared.

On create (`POST /v0beta1/rigs`), `resolveImage` (`src/internal/requests.ts`) swaps
a configured name for its reference before forwarding to smolvm. An `image`
containing `/` or `:` is taken as a full reference and forwarded unchanged,
for development. Any other name is refused with a `400` naming the config file
to edit, so an unconfigured preset never falls through to a Docker Hub pull.
smolvm pulls the reference inside the VM on first use, which needs the
machine's network on (the default).

## Service routes

```
user ──▶ amika server (control plane) ──▶ ngrok ──▶ amika-hostd ──▶ smolvm machine
         authenticates users,                        checks the key,
         sends the host key                          routes to the machine's service
```

Only the amika server calls hostd. It authenticates users itself and sends
the host's secret key; hostd checks the key and routes
`/v0beta1/rigs/<machine>/services/<name>/<path>` to that machine's service, over HTTP
(`fetch`) or a piped WebSocket upgrade.

- The key goes in `X-Amika-Hostd-Key`, since `Authorization` belongs to the
  guest (`amikad` checks SSH connect tokens with it). hostd never forwards
  the key.
- One request needs no key: the SSH WebSocket that `amika sandbox ssh`
  opens, exactly `GET .../services/amikad/v1/ssh-sessions` as an upgrade,
  to a running rig whose `amikad` is on port 60999. `amikad` checks the
  connect token the control plane gave the CLI; the key never leaves the
  control plane. Everything else still needs the key.
- Create takes `services: [{ name, port }]`. hostd publishes the ports through
  smolvm and keeps each machine's name-to-port map in `services.json`
  (`src/internal/service-registry.ts`), since smolvm stores no names.
  `PUT /v0beta1/rigs/<name>/services` replaces the map later (the
  provider's `syncRoutes`), on ports published at create.

## API versions

hostd and the control plane upgrade independently, so hostd's API is
versioned. `/v0beta1/rigs` is the current API: the machine routes (create,
get, delete, start, stop, exec, files, services) and the service routes.
`GET /health` lists the versions served (`{ "status": "ok", "apis":
["v0beta1"] }`). `/api/v1/machines` serves the same machine routes, without
service routes, for control planes on providers from before `v0beta1`; remove
it once none are deployed. Change a version's contract only in a new version.

## Authentication

Every route, including `/health` and unknown paths, requires the secret key:
in `X-Amika-Hostd-Key` on service routes, otherwise as
`Authorization: Bearer <secret key>` (the scheme the Amika CLI uses for API
credentials). `src/internal/auth.ts` reads it the same way as amika-mono's
worker auth (`checkWorkerAuth`): strip a leading `Bearer` scheme, trim, compare
in constant time, and answer a mismatch with a plain `401`. It runs before the body
limit, so unauthenticated callers cannot make the daemon buffer a body. The
caller's credential is never forwarded to the Smol runtime. The
`@amika/sandbox` `amika-hostd` provider sends the key from
`AMIKA_HOSTD_SECRET_KEY`. Both sides require at least 32 printable ASCII
characters with no spaces: HTTP clients trim header values, so a padded key
could never match.

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
