#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-dangling-system-symlinks"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

actual="$(find /usr/local/bin /usr/bin -maxdepth 1 -xtype l -print 2>/dev/null | sort | paste -sd, -)"
[[ -z "$actual" ]] && pass "no dangling symlinks in system binary directories" "none"
fail "no dangling symlinks in system binary directories" "$actual"
