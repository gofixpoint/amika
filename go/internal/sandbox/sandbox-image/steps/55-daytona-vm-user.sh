#!/bin/bash
# Selects the unprivileged runtime user for Daytona linux-vm sandboxes.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <daytona-assets-directory>" >&2
  exit 64
fi

install -d -o root -g root -m 0755 \
  /etc/systemd/system/daytona.service.d
install -o root -g root -m 0644 \
  "$1/99-amika-user.conf" \
  /etc/systemd/system/daytona.service.d/99-amika-user.conf
