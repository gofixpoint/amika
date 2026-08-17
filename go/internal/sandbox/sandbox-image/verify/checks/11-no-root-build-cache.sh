#!/bin/bash
# Verifies root-owned Go and build caches were removed from the final image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-root-build-cache"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

present=()
[[ ! -e /root/go ]] || present+=("/root/go")

# Only cached payload counts, which means a non-empty regular file. Empty
# markers are not caches and are not always the image's doing: Docker Desktop
# creates /root/.cache/rosetta while Rosetta emulates Linux AMD64 on Apple
# Silicon, and pam_motd writes a zero-byte motd.legal-displayed the first time
# anything logs in as root, which on a booted sandbox is the provider, not us.
if [[ -d /root/.cache ]]; then
  while IFS= read -r path; do
    present+=("$path")
  done < <(find /root/.cache -mindepth 1 -type f ! -empty ! -path '/root/.cache/rosetta/*' -print)
fi
[[ ${#present[@]} -eq 0 ]] && pass "root Go and general build caches absent" "caches absent"
fail "root Go and general build caches absent" "present: ${present[*]}"
