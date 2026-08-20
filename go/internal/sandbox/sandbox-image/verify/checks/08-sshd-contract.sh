#!/bin/bash
# Verifies SSH daemon configuration disables password and keyboard-interactive auth.
# shellcheck disable=SC1091,SC2034
CHECK_ID="sshd-contract"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

config="/etc/ssh/sshd_config"
failures=()
[[ -f "$config" ]] || failures+=("config missing")

# sshd -T refuses to run at all without its privilege separation directory, and
# /run is wiped on every boot, so no image can supply one. The check creates it
# rather than asserting against a directory that cannot persist. An unrunnable
# sshd -T is also reported as itself: reading its empty output as a verdict used
# to turn a missing directory into a false "auth enabled" failure.
install -d -m 0755 /run/sshd 2>/dev/null || true
sshd_errors="$(mktemp)"
if effective="$(sshd -T 2>"$sshd_errors")"; then
  grep -q '^passwordauthentication no$' <<<"$effective" || failures+=("password auth enabled")
  grep -q '^kbdinteractiveauthentication no$' <<<"$effective" || failures+=("keyboard-interactive auth enabled")
else
  failures+=("sshd -T failed: $(tr -d '\r' <"$sshd_errors" | tr '\n' ' ')")
fi
rm -f "$sshd_errors"
[[ "$(readlink /etc/systemd/system/ssh.socket 2>/dev/null || true)" == "/dev/null" ]] || failures+=("ssh.socket not masked")
[[ "$(readlink /etc/systemd/system/ssh.service 2>/dev/null || true)" == "/dev/null" ]] || failures+=("ssh.service not masked")

[[ ${#failures[@]} -eq 0 ]] && pass "sshd hardened and system services masked" "contract satisfied"
fail "sshd hardened and system services masked" "${failures[*]}"
