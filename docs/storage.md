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

## File Mount Copies

When `rwcopy` mode is used with individual files (not directories), Amika copies the file into a local directory:

- `${XDG_STATE_HOME:-~/.local/state}/amika/amika-volumes.d/`
- Or `${AMIKA_STATE_DIRECTORY}/amika-volumes.d/` when the override is set

These copies are cleaned up when the associated sandbox is deleted with `--delete-volumes`.
