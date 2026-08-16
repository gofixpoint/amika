#!/bin/bash
# Verifies Docker can run a container in the coder-dind image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="dind-smoke"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

if [[ "$PRESET" != "coder-dind" ]]; then
  skip "docker run --rm hello-world succeeds for dind preset" "not applicable to preset $PRESET"
fi
actual="$(run_as_runtime_user docker run --rm hello-world 2>&1)"
status=$?
[[ $status -eq 0 ]] && pass "docker run --rm hello-world succeeds for dind preset" "container succeeded"
fail "docker run --rm hello-world succeeds for dind preset" "exit=$status output=$actual"
