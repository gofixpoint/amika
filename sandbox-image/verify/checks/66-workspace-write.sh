#!/bin/bash
# Verifies the runtime user can write to the configured workspace.
# shellcheck disable=SC1091,SC2034
CHECK_ID="workspace-write"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

user="$(runtime_user)"
workspace="$(manifest_value image.workspace)"
if sudo -u "$user" test -w "$workspace" && [[ "$(stat -c '%U:%G' "$workspace" 2>/dev/null || true)" == "$user:$user" ]]; then
  pass "workspace is writable and owned by runtime user" "$workspace is writable and owned by $user"
fi
fail "workspace is writable and owned by runtime user" "owner=$(stat -c '%U:%G' "$workspace" 2>/dev/null || true) writable=$(sudo -u "$user" test -w "$workspace" && echo yes || echo no)"
