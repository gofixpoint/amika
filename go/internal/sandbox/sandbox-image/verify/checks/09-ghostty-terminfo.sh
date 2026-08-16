#!/bin/bash
# Verifies the Ghostty terminal definition resolves in the final image.
# shellcheck disable=SC1091,SC2034
CHECK_ID="ghostty-terminfo"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

if TERM=xterm-ghostty infocmp >/dev/null 2>&1; then
  pass "xterm-ghostty terminfo compiles and resolves" "infocmp succeeded"
fi
fail "xterm-ghostty terminfo compiles and resolves" "infocmp failed"
