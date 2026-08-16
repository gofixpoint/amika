#!/bin/bash
# Verifies boot restored setuid permissions required by the runtime.
# shellcheck disable=SC1091,SC2034
CHECK_ID="setuid-survived"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

user="$(runtime_user)"
mode="$(stat -c '%a' /usr/bin/sudo 2>/dev/null || true)"
sudo_status="$(sudo -u "$user" sudo -n true >/dev/null 2>&1; printf '%s' "$?")"
if [[ "$mode" == "4755" && "$sudo_status" == "0" ]]; then
  pass "sudo remains mode 4755 and works for runtime user" "mode=$mode sudo=ok"
fi
fail "sudo remains mode 4755 and works for runtime user" "mode=$mode sudo_exit=$sudo_status"
