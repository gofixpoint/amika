#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <stable-assets-directory>" >&2
  exit 64
fi

tic -x -o /usr/share/terminfo "$1/ghostty.terminfo"

install -d -m 0755 /etc/ssh/sshd_config.d /etc/systemd/system /run/sshd
cat > /etc/ssh/sshd_config.d/00-amika.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
EOF
ln -sfn /dev/null /etc/systemd/system/ssh.socket
ln -sfn /dev/null /etc/systemd/system/ssh.service
