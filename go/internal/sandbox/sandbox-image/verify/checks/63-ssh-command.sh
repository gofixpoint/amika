#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="ssh-command"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

[[ -n "${AMIKA_VERIFY_SSH_COMMAND:-}" ]] || skip "SSH through amikad succeeds" "AMIKA_VERIFY_SSH_COMMAND not supplied by provider adapter"
actual="$(bash -c "$AMIKA_VERIFY_SSH_COMMAND" 2>&1)"
status=$?
[[ $status -eq 0 ]] && pass "SSH through amikad succeeds" "command succeeded"
fail "SSH through amikad succeeds" "exit=$status output=$actual"
