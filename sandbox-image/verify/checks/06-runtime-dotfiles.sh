#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="runtime-dotfiles"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

user="$(runtime_user)"
home="$(runtime_home)"
missing=()
while IFS= read -r dotfile; do
  path="$home/$dotfile"
  owner="$(stat -c '%U:%G' "$path" 2>/dev/null || true)"
  [[ -f "$path" && "$owner" == "$user:$user" ]] || missing+=("$path=$owner")
done < <(manifest_lines image.dotfiles)

[[ ${#missing[@]} -eq 0 ]] && pass "manifest dotfiles present and runtime-user owned" "all dotfiles match"
fail "manifest dotfiles present and runtime-user owned" "${missing[*]}"
