#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

git config core.hooksPath "$REPO_ROOT/githooks"

echo "Git hooks path configured to: $REPO_ROOT/githooks"
