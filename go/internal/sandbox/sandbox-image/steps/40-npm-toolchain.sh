#!/bin/bash
# Installs the pinned global npm development toolchain.

set -euo pipefail

: "${NPM_VERSION:?NPM_VERSION must be set}"
: "${PNPM_VERSION:?PNPM_VERSION must be set}"
: "${TYPESCRIPT_VERSION:?TYPESCRIPT_VERSION must be set}"
: "${TSX_VERSION:?TSX_VERSION must be set}"

# Upgrade npm on its own first, so the tools below install with the pinned npm.
npm install -g "npm@${NPM_VERSION}"

npm install -g \
  "pnpm@${PNPM_VERSION}" \
  "typescript@${TYPESCRIPT_VERSION}" \
  "tsx@${TSX_VERSION}"

rm -rf /root/.npm /root/.cache
