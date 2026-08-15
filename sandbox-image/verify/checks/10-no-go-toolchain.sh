#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="no-go-toolchain"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

actual="$(command -v go 2>/dev/null || true)"
[[ -z "$actual" ]] && pass "no Go toolchain in final image" "go absent"
fail "no Go toolchain in final image" "$actual"
