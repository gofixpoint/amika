# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It will manage
local VMs and make them accessible through the Amika control plane. The current
daemon serves `GET /health` and a Smol-compatible `/api/v1/machines` API, and
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

- the bundle and `config.example.toml` into `~/.amika-hostd`
  (`AMIKA_HOSTD_HOME`), with an `amika-hostd` launcher on `AMIKA_INSTALL_DIR`
  (default `/usr/local/bin`) that pins the node it runs on;
- Node.js: the system `node` if it is 22 or newer, otherwise the official
  Node.js LTS binary (24.21.0, `AMIKA_HOSTD_NODE_VERSION`), verified against
  `SHASUMS256.txt`, into `~/.amika-hostd/node` (the system node is never
  touched);
- smolvm, through its official installer, unless `smolvm` is on `PATH` or in
  `~/.smolvm` or `~/.local/bin`. Pin it with `--smolvm-version`
  (`SMOLVM_VERSION`) or skip it with `--skip-smolvm`;
- a config: `config.example.toml` copied to the user config path below, unless
  a config already exists there or in `/etc`. It is never overwritten.

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

- `amika-hostd up [--port N] [--host H]` starts the daemon in the background:
  it re-runs itself as `serve --smolvm` with `detached: true`, appends output to
  `$XDG_STATE_HOME/amika-hostd/amika-hostd.log` (default `~/.local/state`), and
  waits for the child's IPC `ready` message, so startup failures print in the
  caller's terminal. Only the operator's own flags are forwarded; the child
  inherits the environment and re-reads the TOML file.
- `amika-hostd up --fg` and `amika-hostd serve` run in the foreground until
  `SIGINT` or `SIGTERM`. Shutdown waits up to 5 seconds for in-flight requests,
  then drops the rest, and the process exits a second later even if a request
  to the Smol runtime is still pending, so a slow client or runtime cannot keep
  the daemon alive. If the launching `up` exits before the child is ready, the
  child shuts down too.
  Only `up` registers with Amika; `serve` does not. `up` (either way) and
  `serve --smolvm` also run smolvm; plain `serve` does not, for development.
- `amika-hostd down` sends `SIGTERM` to the daemon named by the pidfile and
  waits for it to exit, which includes stopping smolvm. It needs no
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

Every run claims `amika-hostd.pid` next to the log, atomically, and refuses to
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

1. Before claiming anything, it refuses to start if a smolvm from an earlier
   run is still alive (`smolvm.pid`, next to the daemon's pidfile) or if
   anything already answers `GET /health` at `SMOL_API_URL`: a smolvm it did
   not start is not the daemon's to stop.
2. It finds `smolvm` on `PATH`, else where the smolvm installer puts it
   (`~/.smolvm/smolvm` or `~/.local/bin/smolvm`), and runs
   `smolvm serve start --listen <host:port of SMOL_API_URL>`. smolvm's own
   default is a Unix socket, so the address is always passed, and
   `SMOL_API_URL` must be a plain `http://host:port`. smolvm gets its own
   process group, so Ctrl-C on `up --fg` reaches only the daemon; its output
   goes to `smolvm.log`; and it never sees the API key or secret key.
3. The daemon listens only once smolvm answers `/health` (30s at most), so the
   background `up` reports a smolvm that fails to start.
4. On shutdown the daemon stops listening first, then sends smolvm `SIGTERM`
   and waits up to 60s. smolvm is started with `SMOLVM_DRAIN_ON_SHUTDOWN=1`,
   so it stops every machine cleanly (disks are kept; nothing is deleted)
   instead of leaving them running, which is its default. It is never killed
   outright: if it is still stopping machines after 60s, the daemon exits and
   `down` goes on waiting for it.
5. If smolvm exits on its own, the daemon stops too, with exit code 1, rather
   than answer every request with a `502`.

`down` stops the daemon, then any smolvm a daemon left behind (one killed with
`SIGKILL`, or that timed out stopping it). The smolvm pidfile is acted on, not
only read, so a pid counts as smolvm only when its program is confirmed to be
`smolvm` or `smolvm-bin` (the binary the `smolvm` launcher `exec`s), from
`/proc` or `ps`.

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
two are not merged, and unknown keys are rejected. `SMOL_API_URL` (default
`http://127.0.0.1:8080`, where `up` starts smolvm) and
`SMOL_REQUEST_TIMEOUT_MS` remain environment-only. `config.example.toml`
is the annotated template for operators: copy it to one of those paths and
uncomment what you need. `config.test.ts` resolves it, so keep it in step with
the schema. Never include a secret or
file contents in a `ConfigError` message: operators see it verbatim.

### Images

`[images]` maps a preset name to the full OCI reference this host boots for it,
so the host, not Amika, pins the version:

```toml
[images]
amika-coder = "ghcr.io/gofixpoint/amika-coder:<12-char sha>"
amika-coder-plus-docker = "ghcr.io/gofixpoint/amika-coder-plus-docker:<12-char sha>"
```

On `POST /api/v1/machines`, `resolveImage` (`src/internal/requests.ts`) swaps
a configured name for its reference before forwarding to smolvm. An `image`
containing `/` or `:` is taken as a full reference and forwarded unchanged,
for development. Any other name is refused with a `400` naming the config file
to edit, so an unconfigured preset never falls through to a Docker Hub pull.
smolvm pulls the reference inside the VM on first use, which needs the
machine's network on (the default).

## Authentication

Every route, including `/health` and unknown paths, requires
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
