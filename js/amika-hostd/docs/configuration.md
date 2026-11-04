# Configuration

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
| Snapshot dir |          | `AMIKA_HOSTD_SNAPSHOT_DIR`                    | `snapshot_dir`                 | in the state directory  |
| Transport    |          | `AMIKA_HOSTD_TRANSPORT`                       | `transport`                    | `tunnel`                |
| amikad       |          |                                               | `amikad_path`                  | the one setup installs  |

Setting both names of an aliased pair to different values is an error, never a
silent pick. A blank variable (empty, or only whitespace) sets nothing; code
that asks which variable sets a setting uses `envName`, which applies the same
rule, rather than testing `env[name]` itself. The API key never comes from TOML: a TOML `api_key` fails
startup. Without one in the environment, the key `setup` stored is used (see
[Secret storage](setup-and-secrets.md#secret-storage)).
The hostname must be a lowercase RFC 1123 hostname, the rule the control plane
enforces, so a bad one fails locally instead of at registration.
The TOML file is the first of `$XDG_CONFIG_HOME/amika-hostd/config.toml`
(default `~/.config/...`) and `/etc/amika-hostd/config.toml` that exists; the
two are not merged, and unknown keys are rejected. `SMOL_API_URL` (where `up`
and `serve --smolvm` start smolvm, by default the first free port from
`http://127.0.0.1:23020`, see [smolvm](runtime.md#smolvm); plain `serve` forwards to a
fixed `http://127.0.0.1:23020`) and `SMOL_REQUEST_TIMEOUT_MS` remain
environment-only. `config.example.toml`
is the template the installer seeds: every setting with a default is a live
line, and only `hostname` and `secret_store` are commented. It holds no
`secret_key`, since the secrets live in the keychain by default. Keep its comments short. `config.test.ts`
resolves it as seeded, so keep it in step with the schema. Never include a secret or
file contents in a `ConfigError` message: operators see it verbatim.

## Bare metal

`[runtimes.bare_metal]` makes this machine one rig, beside or instead of the
VM runtimes. It takes only `enabled`: no `max_running` (it runs one rig) and
no sizes (the rig is the machine, at its own size), and no preset names it,
since it boots no image. `install-amika-hostd.sh --bare-metal` seeds a config
with only this table, and `capabilities update --enable bare_metal` adds it.
A host without smol starts no smolvm, checks no smolvm version and pre-pulls
no images. The old `host_type` key fails startup, naming the table.
`amikad_path` names the amikad binary the runtime runs instead of the release
hostd installs, for development. It must be absolute: hostd runs amikad by
path, never through a shell or `PATH`. See
[Bare-metal runtime](runtime.md#bare-metal-runtime).

## Runtimes

`src/internal/runtimes.ts` checks the runtime and preset tables (spec 028 in
amika-mono). `[runtimes.<name>]` turns on a runtime: `smol` (Linux VMs),
`lume` (macOS VMs, on Apple Silicon only) or `bare_metal` (this machine; see
[Bare metal](#bare-metal)). With no `[runtimes]` table only
`smol` is on. A runtime with `enabled = false` is off. hostd refuses to start a
runtime the machine cannot run (`HostPlatform.runtimes`).

- `max_running` limits the running rigs of a runtime. Lume's limit is the
  smaller of the setting and 2, because macOS runs at most two macOS VMs.
- `[runtimes.<name>.sizes.*]` replaces the default `[sizes]` list for that
  runtime. The two lists are not merged.
- `runtimes.lume.storage_dir` (absolute, required) is where hostd keeps its
  Lume VMs, apart from other Lume VMs on the Mac.

## Images

`[presets.<name>.runtimes.<runtime>]` gives a preset's image on one runtime,
so the host, not Amika, pins the version. Preset names are Amika's
(`coder`). smol takes a full OCI reference:

```toml
[presets.coder.runtimes.smol]
image = "ghcr.io/gofixpoint/amika-coder:latest"
```

A preset with two or more runtimes needs `default_runtime`. All runtimes of a
preset must give one guest OS. An entry for a runtime that is off is ignored
with a warning, and so is a preset with no runtime on.

The old `[preset_images]` table fails startup. `amika-hostd config upgrade`
rewrites it as `[presets.*]` tables.

The seeded config tracks `:latest`, which every image release moves. A host
that needs a fixed version pins the release's 12-character commit SHA instead.
smolvm's image cache (below) is keyed by the digest a reference points to, so
a moved tag is pulled again rather than served stale.

On create (`POST /v0beta1/rigs`), `resolveSource` (`src/internal/requests.ts`)
swaps a preset name (`coder`, or `amika-coder` as control planes send it) for
its smol image before forwarding to smolvm. A name
this host holds as a snapshot is resolved to that artifact instead (see
[Snapshots](snapshots.md)). Failing both, an `image` containing `/` or `:` is
taken as a full reference and forwarded unchanged, for development. Any other
name is refused with a `400` naming the config file to edit, so an
unconfigured preset never falls through to a Docker Hub pull.
smolvm pulls the reference inside the VM on first use, which needs the
machine's network on (the default).

## Image cache

An image is several GB, and without a cache every rig downloads its own copy
into its own disk, so a rig can sit in "Creating" for minutes, and rigs
created together split the bandwidth. smolvm caches a pulled registry image as
a shared, read-only "seed": a new machine of that image starts from a
copy-on-write overlay of it (an APFS clone on macOS) instead of pulling. Seeds
are keyed by the digest the reference points to, resolved on the host with
smolvm's registry credentials (its own config, then Docker's), and concurrent
creates of one image share a single build.

- **Disks under 20 GiB are never cached.** smolvm seeds only a disk at least
  as large as its 20 GiB template (`SMOLVM_SEED_MIN_DISK_GIB` in
  `src/internal/prepull.ts`); a smaller one is the template shrunk with
  `resize2fs`, and pulls its image every time. So the default `tiny` and
  `small` sizes have 20 GiB disks (`DEFAULT_SIZES`), and `up` warns about any
  configured size under 20 GiB. Lower them once smolvm can seed smaller disks.
- **smolvm 1.24.0 or newer** (`MIN_SMOLVM_VERSION`) grows a seed to a larger
  disk and, when `smolvm serve` starts, refreshes the seeds of images machines
  used in the last week. `up` warns when `smolvm --version` reports an older
  one; it says nothing when smolvm cannot be run. The check runs alongside
  registration, and like `smolvm serve` it never sees the API key or the
  secret key.
- **Pre-pull.** Once a daemon running its own smolvm is ready, it makes sure
  every configured image is in the cache, on every start, in the background
  and one at a time (`prepullImages`): it creates an unstarted throwaway
  machine `amika-hostd-prepull-<random>` (`createUnstarted`: a 20 GiB disk, so
  smolvm seeds it, and network on) and deletes it. smolvm attaches a seed at
  create without booting the VM, building it first when it is missing, so a
  cached image costs one registry request to resolve its digest (well under
  a second), and a new image, a moved tag, or a seed smolvm evicted or lost
  is downloaded then rather than by the next rig. Checking every time,
  rather than once, matters because smolvm's cache is not permanent: it
  evicts unused seeds over its 20 GiB cap, a smolvm upgrade makes every seed
  stale (its own startup refresh covers only images used in the last week),
  and a reinstall loses them, and smolvm keeps no other copy of an image.
  smolvm logs, but does not report, a seed it fails to build, so a create
  that succeeds is no proof the image is cached.
  - `prepull.json` in the state directory records the images pulled
    before, which only decide what `up` announces, and the throwaway
    machines hostd created and has not yet deleted. That file, not
    `config.toml`, holds this state: setup owns the config and rejects keys
    it does not know.
  - A failure is logged and retried on the next start; until then a rig of
    that image pulls it itself if its seed is missing.
  - Each throwaway machine is recorded before it is created, and forgotten
    once deleted, so the machines a run cut short left behind are deleted
    first. Only recorded machines are ever deleted, and only hostd's own
    are left out of the machine list (`hiddenMachines`) so Amika never sees
    them as rigs: a rig that merely shares the prefix, made before it was
    reserved, is left alone. The list hides the recorded machines plus every
    name this daemon's pre-pull has used or cleaned up (`used`), kept after
    the machine is deleted, so a list smolvm answered mid-create or mid-delete never
    shows one. A create naming the prefix is refused (`400`). The rest of a
    throwaway machine's name is 16 random hex digits, so it never takes
    another machine's name, nor that of one hostd could not delete. A create
    smolvm still refuses as taken (`409`) is never cleaned up, since the
    machine is someone else's.
  - Each create may take an hour (`PREPULL_TIMEOUT_MS`), since smolvm builds
    a missing seed before answering. The pre-pull stops whenever the daemon
    stops, quietly, leaving a machine it was creating recorded for the next
    start to delete; any other error from it is logged, never fatal to the
    daemon. Rig creates keep their own timeout (`SMOL_REQUEST_TIMEOUT_MS`).
  - While an image's create runs, a rig create of that image gets `503`
    with `Retry-After: 60` instead of waiting out its deadline behind the
    download. The images in flight are kept in memory (`pulling`), not in
    `prepull.json`.
- **The announcement.** `up` reads `prepull.json` before starting the daemon
  and, once it is ready, lists the images never pulled before and where
  progress is logged (the log file, or the terminal under `--fg`). It prints
  nothing when every image is recorded, so the message appears on the first
  `up`, and again only for a new image or one whose pull failed. A routine
  check of cached images is not announced.
