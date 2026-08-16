#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="agent-hooks-registered"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

user="$(runtime_user)"
home="$(runtime_home)"
binary="$(readlink -f "$(command -v amikalog 2>/dev/null)" 2>/dev/null || true)"
invalid=()
while IFS= read -r relative; do
  path="$home/$relative"
  owner="$(stat -c '%U:%G' "$path" 2>/dev/null || true)"
  [[ -f "$path" ]] || invalid+=("$path=missing")
  [[ "$owner" == "$user:$user" ]] || invalid+=("$path owner=$owner")
  [[ -n "$binary" ]] && grep -Fq "$binary" "$path" 2>/dev/null || invalid+=("$path missing $binary")
done < <(manifest_lines image.agent_hook_paths)

[[ ${#invalid[@]} -eq 0 ]] && pass "agent hooks registered for runtime user with absolute amikalog path" "all hook configs match"
fail "agent hooks registered for runtime user with absolute amikalog path" "${invalid[*]}"
