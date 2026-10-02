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
- a config: `config.example.toml` copied to the user config path below, with
  `secret_key` set to a generated `openssl rand -hex 32` and `hostname` set to
  this machine's lowercased `hostname` (left commented when it isn't a valid
  hostname), unless a config already exists there or in `/etc`. It is never
  overwritten.

Its closing steps point the operator at `amika-hostd setup`, then
`amika-hostd up` (which runs setup itself if it was skipped).

On Linux it warns, without failing, when `/dev/kvm` is missing or not
accessible. `--dry-run` prints the plan. Nothing else needs to run alongside
the daemon: `amika-hostd up` starts smolvm itself (see [smolvm](#smolvm)).

The release artifact is one ESM file, built by `pnpm --filter @amika/hostd
bundle` (`scripts/bundle.mjs`, esbuild with every npm dependency inlined), so
it runs under plain `node` with no `node_modules`; `src/bundle.test.ts` checks
that. `scripts/package-release.sh <version> [out-dir]` wraps it and the
example config in the tarball and writes `checksums.txt`. The Release workflow
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

- `amika-hostd setup` asks for the hostname, secret key and API key, and
  writes them (see [Setup](#setup)).
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
- `amika-hostd down` sends `SIGTERM` to the daemon named by the pidfile and
  waits for it to exit, which includes stopping smolvm. It needs no
  configuration.
- `amika-hostd register-url <url>` records the host's public URL and exits.

## Setup

`src/internal/setup.ts` runs `amika-hostd setup`, which needs a terminal. It
edits the TOML file `up` reads (the first that exists, else the user path),
and asks, in order:

1. the hostname, defaulting to the configured one, or else the machine's own
   hostname made valid (lowercased, `.local` dropped, other characters turned
   into `-`), re-asking until it is valid;
2. on a rerun, whether to regenerate the secret key; a first run generates
   one (`randomBytes(32)`, hex) without asking, unless the environment sets
   one, which is saved to the file instead (Amika may already know it);
3. the Amika API key, with input hidden, or on a rerun whether to replace
   the stored one. An API key in the environment is used instead, and setup
   does not ask.

It then replaces `hostname` and `secret_key` in place (a live line, else the
commented `# key = ...` one; otherwise it adds them above the first table),
keeping everything else in the file. A `secret_key` too short to use, such as
the example's `REPLACE_ME`, counts as unset and is replaced without asking. A
config written from scratch also gets the example's default `[sizes]` and
`[preset_images]` (`DEFAULT_SIZES` and `DEFAULT_PRESET_IMAGES`, which
`setup.test.ts` keeps in step with `config.example.toml`). It prints the
result and where to edit it. The new contents are parsed before anything is
written, and the file is replaced atomically with mode `0600`.

Registration never changes a stored secret, so setup sends a regenerated one
to Amika (register, then `PUT /api/v0beta1/hosts/{id}` with `secret`) for the
hostname `up` will use, the environment's if it sets one. It writes the file
first, so a file it cannot write never leaves Amika with a secret the host
lacks. A new hostname skips this, since `up` registers it as a new host. A
secret key set in the environment is never regenerated: the daemon would keep
using it.

Setup applies its changes as one step, in order: store the API key, write
the file, send a regenerated secret to Amika. It listens for `SIGINT` from
the first change to the last, and cancels the Amika request. On any failure,
or Ctrl-C at any point in that step, it undoes what it has done in
reverse: Amika gets the old secret again unless it plainly refused the new
one, the file is restored (or deleted, if setup created it), and the previous
API key is put back (or removed). `AmikaApiError.refused` marks a plain
refusal: an error status below 500 or a refused redirect, never a timeout, a
lost connection, a 5xx, a 2xx other than the expected one, or an unreadable
answer. Ctrl-C then exits 130 with
nothing changed, and a second Ctrl-C stops at once. If an undo fails too,
setup names what may be left changed; if Amika cannot be given the old secret
back, the file keeps the new one, the likelier match after an unanswered
request.

Node runs a `SIGINT` listener only between turns of the event loop, never
during a synchronous step such as a keychain command or a file write, so
setup yields (`setImmediate`) after each step before checking for Ctrl-C.
Ctrl-C also reaches the keychain program, which is in the same process
group; a keychain command killed by `SIGINT` raises `KeychainInterrupted`
rather than counting as a refusal to fall back to the file from.

`up` runs setup first whenever the hostname, secret key or API key is
missing and it has a terminal; without one it fails, naming `setup`. Ctrl-C
during setup exits 130 and changes nothing.

### API key storage

`src/internal/credentials.ts` keeps the API key that setup asks for, and
`up` and `register-url` read it when the environment sets none:

- **macOS**: the login keychain (`security`, service `amika-hostd`, account
  `api-key`). The key is written through `security -i` on stdin, so it never
  appears in the process list, and read back to confirm it was stored.
- **Linux desktop** (`DBUS_SESSION_BUS_ADDRESS` set): the Secret Service via
  `secret-tool`, which takes the key on stdin.
- **Otherwise** (headless Linux, an SSH session, or a keychain that refused):
  `$XDG_CONFIG_HOME/amika-hostd/api-key`, mode `0600`, the way `gh` and
  Docker fall back when no keyring is available.

Reads try the keychain first, then the file. So when the keychain refuses a
new key, the old one is deleted from it before the file is written, and
setup fails unless the keychain then reports the key as not found (`security`
exit 44, a silent `secret-tool` exit 1). A locked or unreachable keychain
cannot be checked, so it never counts as empty. When the keychain takes the key, the file is
deleted, or overwritten with the new key if it cannot be, since a session
without the keychain reads it. The background daemon never
reads the API key, from either.

The secret key stays in `config.toml` (mode `0600`) rather than a keychain:
the detached daemon reads it on every start, with no one there to unlock a
keychain. This is how other unattended daemons keep their keys: WireGuard's
`PrivateKey` in `/etc/wireguard/*.conf`, `tailscaled`'s state file, `sshd`'s
host keys.

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
   run is still alive (`smolvm.pid`, next to the daemon's pidfile) or if
   anything already answers `GET /health` at `SMOL_API_URL`: a smolvm it did
   not start is not the daemon's to stop.
2. It finds `smolvm` on `PATH`, else where the smolvm installer puts it
   (`~/.smolvm/smolvm` or `~/.local/bin/smolvm`), and runs
   `smolvm serve start --listen <host:port of SMOL_API_URL>`. smolvm's own
   default is a Unix socket, so the address is always passed, and
   `SMOL_API_URL` must be a plain `http://<IP address>[:port]` (port 80 if
   omitted), since `--listen` takes no hostnames such as `localhost`. The
   address must be loopback (`127.0.0.0/8` or `[::1]`): smolvm's API has no
   authentication, so listening anywhere else would expose it without
   amika-hostd's bearer check. smolvm gets its own process group, so Ctrl-C on `up --fg` reaches only the
   daemon; its output goes to `log/smolvm.log`, with `NO_COLOR=1` so the log carries
   no ANSI color codes; and it never sees the API key or
   secret key.
3. The daemon listens only once smolvm answers `/health` (30s at most), so the
   background `up` reports a smolvm that fails to start. A shutdown signal
   while it waits stops smolvm and exits without listening.
4. On shutdown the daemon stops listening first, then sends smolvm `SIGTERM`
   and waits up to 60s. smolvm is started with `SMOLVM_DRAIN_ON_SHUTDOWN=1`,
   so it stops every machine cleanly (disks are kept; nothing is deleted)
   instead of leaving them running, which is its default. It is never killed
   outright: if it is still stopping machines after 60s, the daemon exits and
   `down` goes on waiting for it.
5. If smolvm exits on its own, the daemon stops too, with exit code 1, rather
   than answer every request with a `502`.

`down` stops the daemon, then any smolvm a daemon left behind (one killed with
`SIGKILL`, or that timed out stopping it). Both pidfiles are acted on, not
only read, so `down` signals a pid only when `/proc` or `ps` confirms its
program: `amika-hostd` (the daemon's title) for the daemon, and `smolvm` or
`smolvm-bin` (the binary the `smolvm` launcher `exec`s) for smolvm. A daemon
pidfile naming a live process that is not confirmed is left alone, and `down`
says to remove it if it is stale, as `up` does.

## Configuration

`src/internal/config.ts` resolves every setting in one place. Each setting takes
the first source that sets it: CLI flag, then environment, then TOML file.

| Setting    | Flag     | Environment                                   | TOML         | Default                 |
| ---------- | -------- | --------------------------------------------- | ------------ | ----------------------- |
| API key    |          | `AMIKA_HOSTD_API_KEY` / `AMIKA_API_KEY`       | (rejected)   | stored by `setup`       |
| API URL    |          | `AMIKA_HOSTD_API_URL` / `AMIKA_API_URL`       | `api_url`    | `https://app.amika.dev` |
| Hostname   |          | `AMIKA_HOSTD_HOSTNAME`                        | `hostname`   |                         |
| Secret key |          | `AMIKA_HOSTD_SECRET_KEY` / `AMIKA_SECRET_KEY` | `secret_key` |                         |
| Bind host  | `--host` | `AMIKA_HOSTD_HOST`                            | `host`       | `127.0.0.1`             |
| Port       | `--port` | `AMIKA_HOSTD_PORT`                            | `port`       | `3020`                  |

Setting both names of an aliased pair to different values is an error, never a
silent pick. The API key never comes from TOML: a TOML `api_key` fails
startup. Without one in the environment, the key `setup` stored is used (see
[API key storage](#api-key-storage)).
The hostname must be a lowercase RFC 1123 hostname, the rule the control plane
enforces, so a bad one fails locally instead of at registration.
The TOML file is the first of `$XDG_CONFIG_HOME/amika-hostd/config.toml`
(default `~/.config/...`) and `/etc/amika-hostd/config.toml` that exists; the
two are not merged, and unknown keys are rejected. `SMOL_API_URL` (default
`http://127.0.0.1:8080`, where `up` starts smolvm) and
`SMOL_REQUEST_TIMEOUT_MS` remain environment-only. `config.example.toml`
is the template the installer seeds: every setting with a default is a live
line, `secret_key = "REPLACE_ME"` deliberately fails validation until replaced,
and only `hostname` is commented. Keep its comments short. `config.test.ts`
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
