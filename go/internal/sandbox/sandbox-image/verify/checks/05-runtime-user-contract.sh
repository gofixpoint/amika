#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="runtime-user-contract"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

user="$(runtime_user)"
expected_shell="$(manifest_value image.runtime_shell)"
actual="$(getent passwd "$user" 2>/dev/null || true)"
[[ -n "$actual" ]] || fail "runtime user exists with expected shell, groups, and passwordless sudo" "user missing"

actual_shell="${actual##*:}"
groups="$(id -nG "$user" 2>/dev/null || true)"
sudo_status="$(sudo -u "$user" sudo -n true >/dev/null 2>&1; printf '%s' "$?")"
if [[ "$actual_shell" == "$expected_shell" && " $groups " == *" sudo "* && "$sudo_status" == "0" ]]; then
  pass "runtime user exists with expected shell, groups, and passwordless sudo" "shell=$actual_shell groups=$groups sudo=ok"
fi
fail "runtime user exists with expected shell, groups, and passwordless sudo" "shell=$actual_shell groups=$groups sudo_exit=$sudo_status"
