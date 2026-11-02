#!/bin/bash
# Drops IPv4 TCP packets that carry IP options, before the kernel parses them.
#
# TODO(CVE-2026-98432): remove this guard once every rig kernel carries the
# upstream fix, commit e3f33b0a1d89 ("ipv4: free inet_opt and ireq_opt after
# an RCU grace period"): 6.1.190 or later on E2B (6.1.158 as of 2026-11-02),
# 6.18.56 or later on smolvm (6.18.55). Remove with it: this script,
# amika-ipv4-options-guard.service, its install in steps/70-hook-assets.sh,
# the call in pre-setup.sh, verify/checks/68-ipv4-options-guard.sh, the
# nftables package in steps/10-os-packages.sh, and both manifest.toml entries.
#
# The bug is a use-after-free. The kernel saves the IP options of a SYN,
# hands them to the accepted socket without a copy, and frees them with a
# plain kfree() while another CPU can still read them to build a SYN-ACK. A
# SYN without options allocates nothing, and normal traffic never carries
# IPv4 options, so dropping those packets removes the trigger. The rule
# covers the root network namespace, which all traffic into the rig crosses.
#
# Safe to run more than once: the first two lines make sure the table exists
# and then delete it, and nft applies the whole file as one transaction.
# systemd runs it at boot (amika-ipv4-options-guard.service); pre-setup.sh
# runs it again for rigs without systemd, such as smolvm.

set -euo pipefail

nft -f - <<'EOF'
table ip amika_ipv4_options_guard
delete table ip amika_ipv4_options_guard
table ip amika_ipv4_options_guard {
  chain prerouting {
    type filter hook prerouting priority raw; policy accept;
    ip protocol tcp ip hdrlength != 5 drop
  }
}
EOF
