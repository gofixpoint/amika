#!/bin/bash
# Verifies package-manager caches are absent from the final image filesystem.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-package-cache"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

nonempty=()
while IFS= read -r path; do
  if [[ -d "$path" ]] && find "$path" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
    nonempty+=("$path")
  fi
done < <(manifest_lines image.package_cache_paths)
[[ ${#nonempty[@]} -eq 0 ]] && pass "manifest package cache paths empty or absent" "all caches clean"
fail "manifest package cache paths empty or absent" "nonempty: ${nonempty[*]}"
