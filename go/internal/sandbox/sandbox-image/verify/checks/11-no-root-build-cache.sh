#!/bin/bash
# Verifies root-owned Go and build caches were removed from the final image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-root-build-cache"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

present=()
[[ ! -e /root/go ]] || present+=("/root/go")

# Docker Desktop creates this empty marker while Rosetta emulates Linux AMD64
# on Apple Silicon. It is removed after verification and is not an image cache.
if [[ -d /root/.cache ]]; then
  while IFS= read -r path; do
    present+=("$path")
  done < <(find /root/.cache -mindepth 1 ! -path /root/.cache/rosetta -print)
fi
[[ ${#present[@]} -eq 0 ]] && pass "root Go and general build caches absent" "caches absent"
fail "root Go and general build caches absent" "present: ${present[*]}"
