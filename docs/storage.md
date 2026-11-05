# Amika Storage Paths

Amika stores its own local files using the XDG Base Directory standard.

## Credential Discovery Files

These files are consumed by `amika auth extract` when present:

- `env-cache.json`: `${XDG_CACHE_HOME:-~/.cache}/amika/env-cache.json`
- `keychain.json`: `${XDG_DATA_HOME:-~/.local/share}/amika/keychain.json`
- `oauth.json`: `${XDG_STATE_HOME:-~/.local/state}/amika/oauth.json`

Amika does not use a legacy `~/.amika` fallback for these files.
