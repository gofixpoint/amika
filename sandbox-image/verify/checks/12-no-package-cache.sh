#!/bin/bash
# Verifies package-manager caches are absent from the final image filesystem.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-package-cache"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

nonempty=()
while IFS= read -r path; do
  # What matters is whether cached package payloads survived, not whether the
  # directory has any entry at all: apt keeps a zero-byte "lock" and an empty
  # "partial" directory even directly after `apt-get clean`, so requiring an
  # empty directory failed images whose caches were in fact clean. Only a
  # non-empty regular file is cached payload.
  if [[ -d "$path" ]] && find "$path" -mindepth 1 -type f ! -empty -print -quit 2>/dev/null | grep -q .; then
    nonempty+=("$path")
  fi
done < <(manifest_lines image.package_cache_paths)
[[ ${#nonempty[@]} -eq 0 ]] && pass "manifest package cache paths hold no cached payload" "all caches clean"
fail "manifest package cache paths hold no cached payload" "nonempty: ${nonempty[*]}"
