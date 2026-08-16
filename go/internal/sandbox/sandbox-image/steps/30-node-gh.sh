#!/bin/bash

set -euo pipefail

: "${NODE_VERSION:?NODE_VERSION must be set}"
: "${GH_VERSION:?GH_VERSION must be set}"

case "$(uname -m)" in
  x86_64) release_arch="x64"; gh_arch="amd64" ;;
  aarch64) release_arch="arm64"; gh_arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

node_archive="node-v${NODE_VERSION}-linux-${release_arch}.tar.xz"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" \
  -o "$temporary_dir/$node_archive"
tar -xJf "$temporary_dir/$node_archive" \
  --strip-components=1 -C /usr/local

gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"
curl -fsSL \
  "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" \
  -o "$temporary_dir/$gh_archive"
tar -xzf "$temporary_dir/$gh_archive" -C "$temporary_dir"
install -m 0755 \
  "$temporary_dir/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" \
  /usr/local/bin/gh

rm -rf /root/.cache
