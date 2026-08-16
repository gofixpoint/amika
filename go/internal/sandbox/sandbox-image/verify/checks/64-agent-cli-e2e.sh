#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="agent-cli-e2e"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

[[ -n "${AMIKA_VERIFY_AGENT_COMMAND:-}" ]] || skip "one agent CLI completes a fixed trivial prompt" "AMIKA_VERIFY_AGENT_COMMAND not supplied by provider adapter"
actual="$(run_as_runtime_user bash -c "$AMIKA_VERIFY_AGENT_COMMAND" 2>&1)"
status=$?
[[ $status -eq 0 ]] && pass "one agent CLI completes a fixed trivial prompt" "command succeeded"
fail "one agent CLI completes a fixed trivial prompt" "exit=$status output=$actual"
