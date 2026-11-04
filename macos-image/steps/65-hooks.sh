#!/bin/bash
# Installs Amika's lifecycle hooks, in /usr/local/lib/amikad: /usr/lib is on
# the sealed system volume, read-only also for root. Shells read Amika's env
# from /etc/profile.d, which provisioning writes, as on Linux.

set -euo pipefail

install -d -m 755 -o root -g wheel /usr/local/lib/amikad /etc/profile.d \
  /usr/local/etc/amikad/setup
for hook in /tmp/amika-image/assets/hooks/*.sh; do
  install -m 755 -o root -g wheel "$hook" /usr/local/lib/amikad/
done
if ! grep -q 'amika-profile-d' /etc/zshrc; then
  cat >> /etc/zshrc <<'ZSHEOF'

# amika-profile-d: Amika's environment for login and interactive shells.
for f in /etc/profile.d/*.sh(N); do source "$f"; done
ZSHEOF
fi
