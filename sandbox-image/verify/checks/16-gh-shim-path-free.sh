#!/bin/bash
# Verifies the app_token gh shim's install path is free and gh resolves behind it.
# shellcheck disable=SC1091,SC2034
CHECK_ID="gh-shim-path-free"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

# The gh shim (installed by the control plane for github_auth_mode=app_token)
# lands at /usr/local/bin/gh and resolves the real binary by scanning PATH for a
# gh that is not itself. It works because /usr/local/bin precedes /usr/bin on
# the standard PATH: the shim shadows the real binary rather than replacing it.
#
# Installing gh at the shim's own path collapses the two, so the shim overwrites
# what it wraps and every invocation exits 127. That regression shipped once and
# reached production, so the invariant is asserted here at build time. Build
# context only: this is a property of the image, and boot checks cost every
# sandbox start.
shim_path="/usr/local/bin/gh"
expected="gh installed outside $shim_path, leaving it free for the shim"

resolved="$(PATH="$(standard_path)" command -v gh 2>/dev/null || true)"
[[ -n "$resolved" ]] || fail "$expected" "gh not found on the standard PATH"
[[ ! -e "$shim_path" ]] || fail "$expected" \
  "gh installed at $shim_path; the app_token shim would overwrite the binary it wraps"

pass "$expected" "gh at $resolved"
