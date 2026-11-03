#!/bin/bash
# Installs Homebrew as `amika`, and the GNU tools and bash 5 that
# provisioning runs with. Homebrew is not pinned: it installs the current
# formulae.

set -euo pipefail

brew=/opt/homebrew/bin/brew
as_amika() {
  sudo -u amika -H env HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 \
    NONINTERACTIVE=1 "$@"
}

if [[ ! -x "$brew" ]]; then
  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
    -o /tmp/homebrew-install.sh
  as_amika /bin/bash /tmp/homebrew-install.sh
  rm -f /tmp/homebrew-install.sh
fi
as_amika "$brew" install coreutils gnu-sed findutils bash jq
as_amika "$brew" cleanup --prune=all

# Homebrew comes first in every shell's PATH, as on a developer's Mac. The
# GNU tools do not: user shells keep the macOS tools, and provisioning puts
# the GNU tools first in its own PATH.
if [[ "$(head -n 1 /etc/paths)" != /opt/homebrew/bin ]]; then
  { printf '%s\n' /opt/homebrew/bin /opt/homebrew/sbin; cat /etc/paths; } \
    >/tmp/paths
  install -m 644 -o root -g wheel /tmp/paths /etc/paths
  rm -f /tmp/paths
fi
