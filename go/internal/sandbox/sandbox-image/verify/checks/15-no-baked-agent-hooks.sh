#!/bin/bash
# Verifies per-user agent hook configuration is not baked into the image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-baked-agent-hooks"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

home="$(runtime_home)"
present=()
while IFS= read -r path; do
  [[ ! -e "$home/$path" ]] || present+=("$home/$path")
done < <(manifest_lines image.agent_hook_paths)
[[ ${#present[@]} -eq 0 ]] && pass "agent hook configuration absent at build time" "hook configs absent"
fail "agent hook configuration absent at build time" "present: ${present[*]}"
