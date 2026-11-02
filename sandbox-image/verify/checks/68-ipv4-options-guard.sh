#!/bin/bash
# Verifies boot loaded the nftables rule that drops IPv4 TCP packets with IP
# options. TODO(CVE-2026-98432): remove with ipv4-options-guard.sh once rig
# kernels are patched.
# shellcheck disable=SC1091,SC2034
CHECK_ID="ipv4-options-guard"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

ruleset="$(nft list table ip amika_ipv4_options_guard 2>&1)"
if grep -q "ip hdrlength != 5 drop" <<<"$ruleset"; then
  pass "IPv4 options guard drops TCP packets with IP options" "table loaded"
fi
fail "IPv4 options guard drops TCP packets with IP options" "$ruleset"
