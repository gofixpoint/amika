#!/bin/bash
# Installs lifecycle hooks and the setuid-restoration and IPv4 options guard
# service assets.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <hook-assets-directory>" >&2
  exit 64
fi

for script in \
  bash-error-prelude.sh \
  docker-setup.sh \
  ipv4-options-guard.sh \
  opencode-setup.sh \
  pi-setup.sh \
  post-setup.sh \
  pre-setup.sh \
  restore-setuid.sh \
  run-hook.sh; do
  install -m 0755 "$1/$script" "/usr/lib/amikad/$script"
done

install -m 0644 "$1/amika-restore-setuid.service" \
  /etc/systemd/system/amika-restore-setuid.service
install -d -m 0755 /etc/systemd/system/sysinit.target.wants
ln -sfn /etc/systemd/system/amika-restore-setuid.service \
  /etc/systemd/system/sysinit.target.wants/amika-restore-setuid.service

# TODO(CVE-2026-98432): remove with ipv4-options-guard.sh once rig kernels
# are patched.
install -m 0644 "$1/amika-ipv4-options-guard.service" \
  /etc/systemd/system/amika-ipv4-options-guard.service
ln -sfn /etc/systemd/system/amika-ipv4-options-guard.service \
  /etc/systemd/system/sysinit.target.wants/amika-ipv4-options-guard.service
