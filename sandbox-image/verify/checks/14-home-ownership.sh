#!/bin/bash
# Verifies the runtime home contains no files unexpectedly owned by root.
# shellcheck disable=SC1091,SC2034
CHECK_ID="home-ownership"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

home="$(runtime_home)"
actual="$(find "$home" -xdev -user root -print 2>/dev/null | sort | head -20 | paste -sd, -)"
[[ -z "$actual" ]] && pass "nothing in runtime home owned by root" "no root-owned paths"
fail "nothing in runtime home owned by root" "$actual"
