# Snapshots

A snapshot is a rig's disks packed into a `.smolmachine` file on this host,
which a later rig boots from. They stay on the host: an org's rigs on its own
hardware never leave it, and neither do their snapshots.

```
POST   /v0beta1/rigs/<rig>/snapshots   {"name": "<org>/sandbox/<label>"} -> 202
GET    /v0beta1/snapshots                     every snapshot this host holds
GET    /v0beta1/snapshots/<name>              one, or 404
DELETE /v0beta1/snapshots/<name>              204; 409 while it is being
                                              taken
```

`src/internal/snapshots.ts` takes one: stop the rig, run `smolvm pack create
--from-vm <rig> -o <staged>`, adopt the `.smolmachine` it writes beside that
stub. `src/internal/snapshot-store.ts` keeps them.

- **Why a pack, and not a checkpoint.** smolvm can also capture a running
  machine (`POST /machines/<name>/checkpoint`), which is one atomic call and
  needs no stop. It captures guest RAM as well as disks, which is wrong for
  Amika's snapshots in two ways: the control plane scrubs a rig's credentials
  before capturing, and a RAM image carries the secrets the scrubbed
  processes still hold; and a checkpoint restores only onto its captured
  CPU/memory/disk topology, while a snapshot is a base image new rigs of any
  size boot from. A pack carries disks only, as a flattened tar of the
  container's layers for an image-based machine, so a scrubbed file is
  absent from the artifact rather than merely unlinked from a block image.
- **Why hostd owns the stop.** `pack create --from-vm` refuses a running
  machine and smolvm has no one call that stops and packs, so the daemon does
  both itself, under a lock that holds the stop and the pack together for one
  rig.
- **Why hostd keeps everything else off the rig.** The pack is a separate
  process, so smolvm's own lifecycle lock is not held across it: smolvm
  starts, execs in or deletes a machine mid-pack without complaint, and the
  pack then reads disks that are being written. So from the moment a capture
  reserves its name until the snapshot is `active` or `failed`, hostd answers
  `409` to every rig route but reading the rig (`leaveCapturedRigAlone`),
  file reads included, since one may boot a stopped rig. The control plane
  holds the rig too, as `snapshotting`, but only while it waits on the
  capture (20 minutes), and a large pack can take longer.
- **Why it is a subprocess.** The HTTP API's only export pushes to an OCI
  registry; a local artifact comes from the CLI. It runs the binary the
  daemon's own smolvm runs (`ManagedSmolvm.binary`), so both read the same
  on-disk machine state, and never with the API key or the secret key. A
  daemon that did not start smolvm (plain `serve`) serves no snapshot routes
  and does not name the feature in `/health`.
- **A capture answers before it finishes.** A pack is gigabytes and minutes,
  far past any HTTP deadline, so `POST .../snapshots` reserves the name and
  answers `202`; the snapshot carries `capturing` until the artifact lands,
  then `active` or `failed` with a reason. The control plane polls it.
- **Only scrub-and-delete.** Stopping the rig rules out the non-destructive
  "snapshot everything and keep it running" mode, so the provider declares
  `fullSnapshotCapture: false` and Amika offers only "snapshot and delete".
- **The scrub window.** The control plane scrubs the rig's credentials over
  `exec` (so the rig is still running), then this stops it. The agent is
  alive for both, and a graceful stop flushes the guest, so a file the scrub
  removed can be written back before the pack reads the disks. Every provider
  Amika supports has this window (none kills the agent before capturing),
  but it is wider here, because stopping a VM runs the guest's shutdown
  rather than freezing it.
- **Names are never paths.** Amika's snapshot names are namespaced
  (`org_abc123/sandbox/nightly`), so they carry slashes. Each artifact's
  filename is a slug plus a digest of the whole name, so no part of a name
  reaches the filesystem and two names that slugify alike keep their own
  files. The routes take the name as a trailing wildcard, decoded once.
- **Resolving one at create.** `resolveSource`
  (`src/internal/requests.ts`) checks `[preset_images]`, then this store,
  then the full-OCI-reference passthrough. The store has to come first,
  because a snapshot name contains slashes and would otherwise be forwarded
  to a registry.
- **Rigs do not need the snapshot they came from.** smolvm copies an
  artifact's layers into its own storage when it creates a machine from one,
  so a snapshot can be deleted while rigs made from it are still here: they
  boot, run and are packed again without it.
- **What an interrupted run leaves.** A capture is abandoned when the daemon
  stops: nothing is left that could adopt an artifact, so on startup the store
  turns every `capturing` entry into `failed`, drops entries whose artifact has
  gone missing, and clears staging. The pack is signalled on a graceful
  shutdown, but it runs in its own process group, so one that outlives a
  `kill -9` keeps writing into a staging directory the next start removes.
