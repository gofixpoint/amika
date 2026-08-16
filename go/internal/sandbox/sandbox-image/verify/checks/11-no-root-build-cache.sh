#!/bin/bash
# Verifies root-owned Go and build caches were removed from the final image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-root-build-cache"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

present=()
for path in /root/go /root/.cache; do
  [[ ! -e "$path" ]] || present+=("$path")
done
[[ ${#present[@]} -eq 0 ]] && pass "root Go and general build caches absent" "caches absent"
fail "root Go and general build caches absent" "present: ${present[*]}"
