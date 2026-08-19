#!/bin/bash
# Installs the pinned ttyd web terminal.
#
# Pi is a terminal agent with no web server of its own, so the Pi web service
# (assets/hooks/pi-setup.sh) fronts it with ttyd — the same way `opencode web`
# fronts OpenCode. Upstream ships static per-architecture binaries rather than
# an archive, so this installs one file.

set -euo pipefail

: "${TTYD_VERSION:?TTYD_VERSION must be set}"

case "$(uname -m)" in
  x86_64) ttyd_arch="x86_64" ;;
  aarch64) ttyd_arch="aarch64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

curl -fsSL \
  "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
  -o "$temporary_dir/ttyd"
install -m 0755 "$temporary_dir/ttyd" /usr/local/bin/ttyd
