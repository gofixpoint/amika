#!/bin/bash
# Verifies boot lifecycle hooks completed and recorded their expected state.
# shellcheck disable=SC1091,SC2034
CHECK_ID="lifecycle-hooks"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

invalid=()
mtimes=()
for hook in pre-setup setup post-setup; do
  log="/var/log/amika/$hook.log"
  [[ -f "$log" ]] || log="/var/log/amikad/$hook.log"
  if [[ ! -f "$log" ]]; then
    invalid+=("$hook=missing")
  elif ! grep -q "finished .* exit=0$" "$log"; then
    invalid+=("$hook=nonzero-or-incomplete")
  else
    mtimes+=("$(stat -c '%Y' "$log")")
  fi
done

if [[ ${#mtimes[@]} -eq 3 ]] && ! (( mtimes[0] <= mtimes[1] && mtimes[1] <= mtimes[2] )); then
  invalid+=("hook-log-order=invalid")
fi

[[ ${#invalid[@]} -eq 0 ]] && pass "pre-setup, setup, and post-setup completed in order with exit 0" "all lifecycle logs successful"
fail "pre-setup, setup, and post-setup completed in order with exit 0" "${invalid[*]}"
