#!/bin/bash
# Installs the pinned global npm development toolchain.

set -euo pipefail

: "${PNPM_VERSION:?PNPM_VERSION must be set}"
: "${TYPESCRIPT_VERSION:?TYPESCRIPT_VERSION must be set}"
: "${TSX_VERSION:?TSX_VERSION must be set}"

npm install -g \
  "pnpm@${PNPM_VERSION}" \
  "typescript@${TYPESCRIPT_VERSION}" \
  "tsx@${TSX_VERSION}"

rm -rf /root/.npm /root/.cache
