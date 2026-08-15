#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="sshd-contract"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

config="/etc/ssh/sshd_config"
failures=()
[[ -f "$config" ]] || failures+=("config missing")
effective="$(sshd -T 2>/dev/null || true)"
grep -q '^passwordauthentication no$' <<<"$effective" || failures+=("password auth enabled")
grep -q '^kbdinteractiveauthentication no$' <<<"$effective" || failures+=("keyboard-interactive auth enabled")
[[ "$(readlink /etc/systemd/system/ssh.socket 2>/dev/null || true)" == "/dev/null" ]] || failures+=("ssh.socket not masked")
[[ "$(readlink /etc/systemd/system/ssh.service 2>/dev/null || true)" == "/dev/null" ]] || failures+=("ssh.service not masked")

[[ ${#failures[@]} -eq 0 ]] && pass "sshd hardened and system services masked" "contract satisfied"
fail "sshd hardened and system services masked" "${failures[*]}"
