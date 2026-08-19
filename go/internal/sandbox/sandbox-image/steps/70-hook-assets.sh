#!/bin/bash
# Installs lifecycle hooks and the setuid-restoration service assets.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <hook-assets-directory>" >&2
  exit 64
fi

for script in \
  bash-error-prelude.sh \
  docker-setup.sh \
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
