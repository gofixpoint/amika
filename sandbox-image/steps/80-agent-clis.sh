#!/bin/bash
# Installs pinned coding-agent CLIs and repairs runtime-home ownership.

set -euo pipefail

: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION must be set}"
: "${CODEX_VERSION:?CODEX_VERSION must be set}"
: "${OPENCODE_VERSION:?OPENCODE_VERSION must be set}"
: "${PI_VERSION:?PI_VERSION must be set}"

npm install -g \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}"
npm install -g --engine-strict --ignore-scripts \
  "@earendil-works/pi-coding-agent@${PI_VERSION}"

chown -R amika:amika /home/amika
rm -rf /root/.npm /root/.cache
