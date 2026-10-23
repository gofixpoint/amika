# Runtime

How the daemon runs smolvm beside itself, and how it serves the machine API on
top of that smolvm.

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
   shares a port, and it refuses to start at all when a held port it tries is a
   smolvm (both `/health` and `/api/v1/machines` answer 2xx): a smolvm it did
   not start would expose unrelated VMs, and is not the daemon's to stop or
   drain. A
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

## Machine runtime

`src/internal/machine-runtime.ts` serves the machine API through the `smol`
sandbox provider from the workspace's `@amika/sandbox`
(`js/sandbox/src/providers/smol`, imported as `@amika/sandbox/smol`), pointed
at the smolvm this daemon started (or `SMOL_API_URL` for plain `serve`).
Create, delete and service ports go through the provider's resource surface,
translated to and from `smolvm serve`'s shapes, which the control plane's
`amika-hostd` provider expects. Machine info (get and list), start and stop,
exec and file reads and writes go through the provider's exported smolvm
client instead, because the machine API's contract carries what the resource
surface drops or adds: each machine's published `ports`, the machine smolvm
answers a start or stop with (so a successful start never hinges on a second
request whose failure would make a create through hostd delete the machine),
exec as argv with any `user`, a file's exact bytes and type (JSON for a
directory), streamed through rather than buffered, and a write left as smolvm
makes it (the resource surface would also hand the file to the `amika` user,
which the calling `amika-hostd` provider already does over exec). Machine and exec replies
are validated only for the fields hostd reads and otherwise passed through
whole, so smolvm's other fields (a machine's `image`, `network`, `mounts`;
exec's exact `stdoutB64`/`stderrB64`) still reach the caller.

- The provider's network setting is per provider, so hostd builds create
  operations with networking and without, and creates each machine with the
  one its request asks for.
- Create also starts the machine (the provider's create does both). It goes
  through the provider's create operation (`smolOperations`) rather than its
  resource surface, whose create takes all three of cpus, memory and disk or
  none: hostd sends only the sizes a request names, so smolvm picks the rest
  itself, from the image's manifest when it has one (a packed image's sizes,
  or a checkpoint's, which refuses any others) or its defaults.
- Host ports are picked and published by the provider. Service routes
  ask it for a running machine's host port (`services.refreshAll`), and
  `PUT .../services` checks the same way that every port is one the machine
  published at create, refusing (`409`) any other. It never reconciles the
  provider's routes, which refuses to drop a port smolvm cannot unpublish:
  hostd routes by name, so a dropped name is simply no longer routed, and its
  port stays published on loopback, unreachable through hostd.
- The provider treats deleting a missing machine as success; hostd answers
  `404` for one, as `smolvm serve` does.
- Every request to smolvm refuses redirects (`redirect: "error"`), so exec
  bodies (commands, environment, stdin) and uploaded files are never resent to
  wherever something answering at `SMOL_API_URL` points them.
- A request smolvm refuses keeps smolvm's status, with one exception: a file
  read smolvm refuses with a `500` whose reason ends in the guest's
  `ENOENT` (`: No such file or directory (os error 2)`) answers `404`. smolvm
  (1.22.1, at least) reports a missing file that way, and Amika reads only a
  `404` as "no such file", which a fresh rig's setup relies on. A timeout
  answers `504` and an unreachable smolvm `502`. The answer is `Smol runtime request failed`,
  followed by smolvm's own reason (`: resize2fs not found`) as one line cut
  to 500 characters, so an operator sees why a start or an image pull failed.
  The reason is withheld for exec, whose errors can echo the command. A
  create's reason has each of its env values (4 characters or longer)
  replaced by `[redacted]`; a later start or stop cannot, since smolvm never
  reports a machine's env.
