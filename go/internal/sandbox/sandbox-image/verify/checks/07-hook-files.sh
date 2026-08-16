#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="hook-files"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

invalid=()
while IFS= read -r path; do
  actual="$(stat -c '%a:%U:%G' "$path" 2>/dev/null || true)"
  [[ "$actual" == "755:root:root" ]] || invalid+=("$path=$actual")
done < <(manifest_lines image.hook_scripts)
while IFS= read -r path; do
  [[ -x "$path" ]] || invalid+=("$path=not-executable")
done < <(manifest_lines image.setup_hooks)

[[ ${#invalid[@]} -eq 0 ]] && pass "hook scripts have declared ownership and executable modes" "all hook files match"
fail "hook scripts have declared ownership and executable modes" "${invalid[*]}"
