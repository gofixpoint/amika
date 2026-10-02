# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It will manage
local VMs and make them accessible through the Amika control plane. The current
daemon serves `GET /health`, the versioned rig API under `/v0beta1/rigs`
(machines and their named services), the Smol-compatible `/api/v1/machines`
API for older control planes, and
registers itself with the Amika control plane when started with `up`. It runs
machines with smolvm's engine embedded in the daemon process, through the
[`smolmachines`](https://www.npmjs.com/package/smolmachines) SDK, so no
`smolvm` binary or server runs beside it; `down` stops the daemon and its
machines.

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
- the machine engine: the `smolmachines` SDK the release carries, into
  `node_modules/` in that same directory, plus this platform's engine
  package (`smolmachines-linux-x64-gnu`, `-linux-arm64-gnu` or
  `-darwin-arm64`: native addon, boot helper, hypervisor libraries and guest
  rootfs, over 100 MB) downloaded from npm (`AMIKA_HOSTD_NPM_REGISTRY`) and
  verified against the release's `engines.sha256`. Any other platform, or
  Linux with a C library other than glibc 2.34+, fails before anything is
  downloaded;
- a config: `config.example.toml` copied to the user config path below, with
  `secret_key` set to a generated `openssl rand -hex 32` and `hostname` set to
  this machine's lowercased `hostname` (left commented when it isn't a valid
  hostname), unless a config already exists there or in `/etc`. It is never
  overwritten.

On Linux it warns, without failing, when `/dev/kvm` is missing or not
accessible. `--dry-run` prints the plan. Nothing else needs to run alongside
the daemon (see [Machine engine](#machine-engine)).

The daemon is one ESM file, built by `pnpm --filter @amika/hostd bundle`
(`scripts/bundle.mjs`, esbuild with every npm dependency inlined except
`smolmachines`, which finds its native files on disk beside its own and so is
installed in `node_modules`). The bundle loads `smolmachines` only when a
command needs the engine (`up` and `serve` check it at startup), so `--help`
runs under plain `node` with no `node_modules`; `src/bundle.test.ts` checks
that. `scripts/package-release.sh <version>
[out-dir]` wraps the bundle, the example config, the `smolmachines` package
at the exact version `package.json` pins, and `engines.sha256` (each
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

- `amika-hostd up [--port N] [--host H]` starts the daemon in the background:
  it re-runs itself as `serve` with `detached: true`, appends output, each line
  timestamped, to `$XDG_STATE_HOME/amika-hostd/log/amika-hostd.log` (else
  `$HOME/.local/state/...`), and waits for the child's IPC `ready` message, so startup failures print in the
  caller's terminal. Only the operator's own flags are forwarded; the child
  inherits the environment and re-reads the TOML file.
- `amika-hostd up --fg` and `amika-hostd serve` run in the foreground until
  `SIGINT` or `SIGTERM`. Shutdown waits up to 5 seconds for in-flight requests,
  then drops the rest, and the process exits a second later even if a
  machine request is still pending, so a slow client or machine cannot keep
  the daemon alive. Before that it waits up to 60s more for its machines to
  stop (see [Machine engine](#machine-engine)). If the launching `up` exits
  before the child is ready, the child shuts down too.
  Only `up` registers with Amika; `serve` does not. `up` refuses to start,
  before registering, on a host that cannot run machines; `serve` only warns,
  for development, and answers machine requests with errors.
- `amika-hostd down` sends `SIGTERM` to the daemon named by the pidfile and
  waits for it to exit, which includes stopping its machines. It needs no
  configuration.
- `amika-hostd register-url <url>` records the host's public URL and exits.

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

## Machine engine

`src/internal/smol.ts` runs machines with smolvm's engine, embedded through
the `smolmachines` SDK (pinned exactly in `package.json`). The engine keeps
its machines in a database shared with the `smol` CLI and every other
embedder on the host, so:

1. hostd labels each machine it creates (`amika-hostd`, plus its cpus,
   memory, disk size and published ports) and sees only labeled machines:
   anyone else's are a `404`. The labels also let it describe a machine it
   is not running without booting it.
2. Machines are persistent (records and disks outlive stop and daemon
   restarts) but not detached: if the daemon dies the engine reaps their VMs,
   and on shutdown the daemon stops them cleanly first (disks are kept;
   nothing is deleted), giving up after 60s. A later daemon starts them
   again on demand.

hostd drives the SDK's native machine handle, which it loads by path from
the installed package, not its `Machine` class: `Machine.create` and
`Machine.connect` wait until every published port accepts connections and
delete a new machine whose ports do not within two minutes, while a rig's
services need not be listening for it to exist. The handle has its own
gaps, which `smol.ts` fills:

- Create only records a machine; `start` boots it. Exec and file access boot
  a stopped machine first, as `smolvm serve` did.
- The engine's `connect` boots a stopped machine synchronously, and is the
  only way to get a handle on one an earlier daemon left behind. hostd always
  boots on a worker thread first (immediate for a running machine), then
  reattaches on the main thread, so the daemon keeps serving meanwhile.
  Deleting such a machine therefore boots it first, and fails while it cannot
  boot; create refuses (`503`) on a host that cannot run machines, so `serve`
  without KVM never records one.
- Lifecycle steps on one machine (attach, boot, stop, delete) run one at a
  time, so concurrent requests never boot it twice; execs and file transfers
  run concurrently once it is up. A failed boot on a host that cannot run
  machines answers `503`.
- Shutdown stops every owned machine that is running, with or without a
  handle, after any boot still in flight for it.
- Exec takes no stdin, so a request's `stdin` is written to a guest temp file
  readable only by the command's user and redirected in with `/bin/sh`.
- Engine errors carry a `[CODE]`, mapped to the status `smolvm serve`
  answered (`NOT_FOUND` 404, `CONFLICT` 409, and so on). Their messages can
  echo commands, so callers only ever see a fixed message.

`SMOL_REQUEST_TIMEOUT_MS` (default 300000) bounds how long a machine request
waits before answering `504`; the engine call itself carries on.

## Configuration

`src/internal/config.ts` resolves every setting in one place. Each setting takes
the first source that sets it: CLI flag, then environment, then TOML file.

| Setting    | Flag     | Environment                                   | TOML         | Default                 |
| ---------- | -------- | --------------------------------------------- | ------------ | ----------------------- |
| API key    |          | `AMIKA_HOSTD_API_KEY` / `AMIKA_API_KEY`       | (rejected)   | required for Amika APIs |
| API URL    |          | `AMIKA_HOSTD_API_URL` / `AMIKA_API_URL`       | `api_url`    | `https://app.amika.dev` |
| Hostname   |          | `AMIKA_HOSTD_HOSTNAME`                        | `hostname`   |                         |
| Secret key |          | `AMIKA_HOSTD_SECRET_KEY` / `AMIKA_SECRET_KEY` | `secret_key` |                         |
| Bind host  | `--host` | `AMIKA_HOSTD_HOST`                            | `host`       | `127.0.0.1`             |
| Port       | `--port` | `AMIKA_HOSTD_PORT`                            | `port`       | `3020`                  |

Setting both names of an aliased pair to different values is an error, never a
silent pick. The API key is environment-only: a TOML `api_key` fails startup.
The hostname must be a lowercase RFC 1123 hostname, the rule the control plane
enforces, so a bad one fails locally instead of at registration.
The TOML file is the first of `$XDG_CONFIG_HOME/amika-hostd/config.toml`
(default `~/.config/...`) and `/etc/amika-hostd/config.toml` that exists; the
two are not merged, and unknown keys are rejected. `SMOL_REQUEST_TIMEOUT_MS`
remains environment-only. `config.example.toml`
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
Because `:latest` is a moving tag, the engine's in-VM image cache can keep serving
the previously pulled digest, so an upgrade is not guaranteed to take effect
until that cache is cleared.

On create (`POST /v0beta1/rigs`), `resolveImage` (`src/internal/requests.ts`) swaps
a configured name for its reference before creating the machine. An `image`
containing `/` or `:` is taken as a full reference and forwarded unchanged,
for development. Any other name is refused with a `400` naming the config file
to edit, so an unconfigured preset never falls through to a Docker Hub pull.
The engine pulls the reference inside the VM on first boot, which needs the
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
- Create takes `services: [{ name, port }]`. hostd publishes each port on a
  host loopback port it picks and keeps each machine's name-to-port map in
  `services.json` (`src/internal/service-registry.ts`), since the engine
  stores no names.
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
caller's credential is never passed to a machine. The
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
