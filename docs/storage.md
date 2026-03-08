# Amika Storage Paths

Amika stores its own local files using the XDG Base Directory standard.

## Credential Discovery Files

These files are consumed by `amika auth extract` when present:

- `env-cache.json`: `${XDG_CACHE_HOME:-~/.cache}/amika/env-cache.json`
- `keychain.json`: `${XDG_DATA_HOME:-~/.local/share}/amika/keychain.json`
- `oauth.json`: `${XDG_STATE_HOME:-~/.local/state}/amika/oauth.json`

Amika does not use a legacy `~/.amika` fallback for these files.

## State Files

- `sandboxes.jsonl`: `${XDG_STATE_HOME:-~/.local/state}/amika/sandboxes.jsonl`
- `volumes.jsonl`: `${XDG_STATE_HOME:-~/.local/state}/amika/volumes.jsonl`
- `amika-volumes.jsonl`: `${XDG_STATE_HOME:-~/.local/state}/amika/amika-volumes.jsonl`
- `mounts.jsonl`: `${XDG_STATE_HOME:-~/.local/state}/amika/mounts.jsonl` _(v0 legacy commands only)_

If `AMIKA_STATE_DIRECTORY` is set, state files are stored there instead:

- `${AMIKA_STATE_DIRECTORY}/sandboxes.jsonl`
- `${AMIKA_STATE_DIRECTORY}/volumes.jsonl`
- `${AMIKA_STATE_DIRECTORY}/amika-volumes.jsonl`
- `${AMIKA_STATE_DIRECTORY}/mounts.jsonl` _(v0 legacy commands only)_

## Amika-Managed Volumes (`amika-volumes`)

Amika-managed volumes are host-side file copies stored in:

- `${XDG_STATE_HOME:-~/.local/state}/amika/amika-volumes.d/`
- Or `${AMIKA_STATE_DIRECTORY}/amika-volumes.d/` when the override is set

These are tracked in `amika-volumes.jsonl` and include:

- **File rwcopy snapshots** (`type: "file"`): When `rwcopy` mode is used with individual files (not directories), Amika copies the file into a subdirectory under `amika-volumes.d/` and bind-mounts the copy into the container.
- **Inline setup scripts** (`type: "setup-script"`): When `SetupScriptText` is provided via the API, the script is written to `amika-volumes.d/` and bind-mounted read-only at `/opt/setup.sh`.

All entries are cleaned up when the associated sandbox is deleted with `--delete-volumes`.

## Docker-Managed Volumes (`volumes`)

Docker-managed volumes are tracked in `volumes.jsonl` and created when `rwcopy` mode is used with **directories**. These are standard Docker named volumes — the Docker daemon manages the underlying storage. Amika tracks them for lifecycle management (sandbox reference counting, cleanup on deletion).

The key difference: `amika-volumes` are host-side file copies managed entirely by Amika, while `volumes` are Docker volumes managed by the Docker daemon and tracked by Amika.
