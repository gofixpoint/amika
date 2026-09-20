#!/bin/bash
# Verifies declared binaries resolve to image-managed executable locations.
# shellcheck disable=SC1091,SC2034
CHECK_ID="binary-target-location"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

invalid=()
runtime_home="$(runtime_home)"
while IFS= read -r binary; do
  # The inner shell expands $1 and command substitution as the runtime user.
  # shellcheck disable=SC2016
  target="$(run_as_runtime_user sh -c 'readlink -f "$(command -v "$1")"' _ "$binary" 2>/dev/null || true)"
  case "$target" in
    /usr/*) ;;
    "$runtime_home"/.codex/packages/standalone/*)
      [[ "$binary" == "codex" ]] || invalid+=("$binary=$target")
      ;;
    *) invalid+=("$binary=$target") ;;
  esac
done < <(manifest_lines "presets.$PRESET.binaries")

[[ ${#invalid[@]} -eq 0 ]] && pass "resolved binaries use managed locations" "all targets valid"
fail "resolved binaries use managed locations" "${invalid[*]}"
