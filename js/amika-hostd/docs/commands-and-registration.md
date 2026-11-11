# Commands and registration

What each `amika-hostd` command does, and how `up` and `register-url` register
the host with Amika.

## Commands

`src/index.ts` is the `amika-hostd` bin; `src/internal/cli.ts` parses commands
with `node:util` `parseArgs` and takes every side effect as a dependency.

- `amika-hostd setup` asks for the hostname and API key, generates the secret
  key, and writes them (see [Setup](setup-and-secrets.md#setup)).
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
  to stop (see [smolvm](runtime.md#smolvm)). If the launching `up` exits before the
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
- `amika-hostd status` says whether the daemon is running, by the same
  pidfile checks `down` makes, and changes nothing. It exits 0 when the
  daemon is up (printing its pid, smolvm's and the log file) and 3 when it is
  not, as LSB init scripts do, so scripts can test it. A smolvm still running
  without its daemon is reported, since `down` is what stops it. Like `down`
  it needs no configuration, and it does not check that Amika can reach the
  daemon (see `amika host get`).
- `amika-hostd register-url <url>` records a listening host's public URL and
  exits. On a host whose address Amika assigns it refuses instead.
- `amika-hostd version` prints the build's version,
  git commit and build date in the format `amika version` uses, and needs no
  configuration. `scripts/bundle.mjs` bakes them in from
  `AMIKA_HOSTD_VERSION`, `AMIKA_HOSTD_COMMIT` and `AMIKA_HOSTD_BUILD_DATE`
  (`src/internal/build-info.ts`), which `scripts/package-release.sh` sets; a
  build without them, or a run from source, reports `dev`.

## Reload and `capabilities update`

A reload applies the config file's runtime settings (`[runtimes.*]`,
`[presets.*]`, `[sizes.*]`, `max_running`) to the running daemon with no
restart, so rigs keep running and the tunnel and SSH sessions stay up
(`src/internal/reload.ts`).

- `SIGHUP` tells the daemon to reload. It reads the file, checks it as `up`
  does, and replaces its runtime settings in one step: a create already
  started uses the old ones. A reload can turn a runtime on (Lume starts at
  once), and off when it has no rigs. It refuses to turn off a runtime that
  has rigs, naming them, and to turn smol on, since smolvm starts only with
  the daemon. Other changed settings (`transport`, `api_url`, and the rest)
  are logged as waiting for a restart.
- A failed reload keeps the old settings. Each reload's result, with a
  number that goes up each time, is in `reload-result.json` in the state
  directory, and in the log.
- `amika-hostd reload [--json]` checks the file first, and with an invalid
  one prints the error and sends no signal. Otherwise it signals the daemon
  and prints the result it writes. It exits 3 when no daemon runs.

`amika-hostd capabilities update --enable|--disable <runtime>` changes
`[runtimes.*]` in `config.toml` and nothing else
(`src/internal/runtime-update.ts`). With no runtime named it asks about each
one this machine can run but smol, as setup does
(`src/internal/runtime-choice.ts`);
without a terminal it then exits with an error naming the flags.

1. It prints the plan. Turning on Lume adds `storage_dir` (in hostd's data
   directory) and, unless a preset already uses Lume, the `macos-coder`
   preset with template `amika-macos-coder`. With no `[runtimes]` table it
   also lists smol, so smol stays on. When Lume is asked for, each template
   a Lume preset boots that Lume does not have is a step of its own, with
   what building it costs (`MACOS_IMAGE_COST`), even when Lume is already
   on: that is how a failed build is retried.
2. It installs Lume `0.6.1` with Lume's own installer, into `~/.local/bin`
   with no `sudo`, when Lume is asked for and not found. It then builds the
   missing images (`src/internal/lume-setup.ts`, see
   [Lume runtime](runtime.md#lume-runtime)) before it changes the file, so a
   build that fails leaves the file as it was, and Amika is never offered
   Lume rigs with no image to boot. Turning on `bare_metal` first checks the
   machine as setup does (an `sshd` binary, and sshd's StrictModes on
   amikad's state directory), and refuses with nothing changed; then it
   installs amikad into hostd's data directory.
3. It writes the file, and reloads a running daemon as `reload` does,
   which then sends Amika the new capabilities.

It refuses to turn off a runtime with rigs, as recorded in `machines.json`.
`--dry-run` prints the plan and changes nothing; `--yes` applies it without
asking; with no terminal and neither flag, it exits with an error naming
both. `--json` prints the plan and result as JSON. A second run with the
same flags makes no change. Setup installs and builds the same things for
the runtimes it turns on.

## Registration

Before starting the daemon, `up` calls `POST /api/v0beta1/hosts` on the Amika
API (`src/internal/amika-api.ts`) with `Authorization: Bearer <API key>` and a
body of `hostname`, `secret`, `sizes` and `transport_mode` (the configured
`transport`). The endpoint is
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

Registration and that `PUT` also send `capabilities`, what the host can run
(`runtimes.ts`). With `bare_metal` on, its entry carries what the machine is
now: `os`, `resources` (`{vcpus, memory_gib, disk_gib}`, detected through
`HostPlatform.detectResources`: logical CPUs, total memory, and the
filesystem holding the home directory) and `ssh_user` (the account hostd runs
as), so every `up` tells Amika again. Before registering, `up` refuses a
runtime this machine cannot run, and with `bare_metal` on installs amikad if
a newer hostd pins a version not yet installed.

The config is the source of truth for the transport too, but Amika never
moves an existing host between transports on registration: it creates a new
host in the transport asked for, and refuses an existing host in another one
with `409 host_transport_conflict`. On that refusal `up` registers again
without `transport_mode`, which returns the stored host, and then sends
`PUT /api/v0beta1/hosts/{id}` with the configured `transport_mode` (and
`url: null` when moving into the tunnel, which takes no URL), printing
`Switched host <name> from <old> to <new> mode`. This happens before tunnel
enrolment, which Amika refuses for a host not in the tunnel. `setup` sends no
`transport_mode`, so a host it registers is created as a listener and moved
by the next `up`.

Registration is complete once Amika knows how it reaches the host. `up` runs
in this order: resolve config, register the hostname and secret, start the
daemon (background, or `--fg`), then complete registration.

A host Amika reaches over its own gateway (`transport_mode: "tunnel"`) is
already complete when it is registered: Amika assigns the address, there is
no URL to give it, and `register-url` on such a host is refused by the daemon
before it sends one, as the API would refuse it too. `up` says so and asks
nothing. Anything that is not a listener is treated this way, so a transport
added later is left for the control plane to answer for rather than being
asked to expose a port. Complete is not the same as reachable: this daemon
only serves locally and opens no outbound connection, so whether Amika can
reach such a host is the control plane's to report, and `up` says so.

For a listening host, completion means its internet-facing URL (an ngrok or
Cloudflare Tunnel URL, for example). If it has no URL and stdin and stdout
are both terminals, `up` asks the operator to expose the now-running daemon
and enter its public URL, re-asking on an invalid URL. A blank answer or
end of input (Ctrl-D) skips it. Ctrl-C exits 130: a background daemon keeps
running, while `--fg` stops. A failed save is reported and the daemon keeps
running (`up` exits 1 in the background). Without a terminal it prints how to
finish instead of blocking. If the host already has a URL, `up` reminds the
operator that Amika expects to reach it there.

`amika-hostd register-url <url>` sets the URL from the same configuration as
`up`: it registers idempotently to learn the host's id, then sends
`PUT /api/v0beta1/hosts/{id}` with the hostname and URL and no secret, so the
stored secret is kept. If that register comes back as anything but a listener,
it refuses by name ("Amika assigns the address of host ...") and never sends
the URL, rather than relaying the 400 the API would answer with. The register
itself still happens, since that is how the transport is learned, and against
an already-registered host that includes the sizes `PUT`. Only absolute
http(s) URLs without credentials are accepted; a bare origin is normalized
without its trailing slash, and a path is kept.

Every run claims `amika-hostd.pid` in that state directory, atomically, and refuses to
start while it names a live daemon. The daemon sets `process.title` to
`amika-hostd`; where `/proc` exists, a pidfile naming any other process is
treated as stale, since the pidfile outlives reboots and pids are reused. An
empty `--host` is rejected, since it would bind every interface. Stop a
background daemon with `amika-hostd down`.
