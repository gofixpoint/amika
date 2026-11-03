#!/bin/bash
# Installs the pinned Node.js release and npm.

set -euo pipefail

: "${NODE_VERSION:?NODE_VERSION must be set}"
: "${NPM_VERSION:?NPM_VERSION must be set}"

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

archive="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
cd "$temporary_dir"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" |
  grep " ${archive}\$" | shasum -a 256 -c - >/dev/null
tar -xzf "$archive" --strip-components=1 -C /usr/local \
  --exclude CHANGELOG.md --exclude LICENSE --exclude README.md

export PATH="/usr/local/bin:$PATH"
npm install -g "npm@${NPM_VERSION}"
rm -rf /var/root/.npm
