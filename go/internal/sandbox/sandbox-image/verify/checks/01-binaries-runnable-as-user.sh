#!/bin/bash
# Verifies every declared binary is runnable by the unprivileged runtime user.
# shellcheck disable=SC1091,SC2034
CHECK_ID="binaries-runnable-as-user"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

missing=()
while IFS= read -r binary; do
  # The inner shell expands $1 and command substitution as the runtime user.
  # shellcheck disable=SC2016
  if ! run_as_runtime_user sh -c 'command -v "$1" >/dev/null 2>&1 && test -x "$(command -v "$1")"' _ "$binary"; then
    missing+=("$binary")
  fi
done < <(manifest_lines "presets.$PRESET.binaries")

[[ ${#missing[@]} -eq 0 ]] && pass "all manifest binaries runnable as runtime user" "all runnable"
fail "all manifest binaries runnable as runtime user" "missing or not executable: ${missing[*]}"
