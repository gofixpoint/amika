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

## Images

`[preset_images]` maps a preset name to the full OCI reference this host boots for it,
so the host, not Amika, pins the version:

```toml
[preset_images]
amika-coder = "ghcr.io/gofixpoint/amika-coder:latest"
amika-coder-plus-docker = "ghcr.io/gofixpoint/amika-coder-plus-docker:latest"
```

The seeded config tracks `:latest`, which every image release moves. A host
that needs a fixed version pins the release's 12-character commit SHA instead.
smolvm's image cache (below) is keyed by the digest a reference points to, so
a moved tag is pulled again rather than served stale.

On create (`POST /v0beta1/rigs`), `resolveSource` (`src/internal/requests.ts`)
swaps a configured name for its reference before forwarding to smolvm. A name
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
    daemon. Rig creates keep their own timeout (`SMOL_REQUEST_TIMEOUT_MS`),
    so a rig created while its image is still downloading may time out,
    which the announcement says.
- **The announcement.** `up` reads `prepull.json` before starting the daemon
  and, once it is ready, lists the images never pulled before and where
  progress is logged (the log file, or the terminal under `--fg`). It prints
  nothing when every image is recorded, so the message appears on the first
  `up`, and again only for a new image or one whose pull failed. A routine
  check of cached images is not announced.
