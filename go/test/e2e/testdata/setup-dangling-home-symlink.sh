#!/bin/bash
# Setup script for the base snapshot boot cases. It leaves a dangling
# symlink in the amika home, as `pnpm install` with pnpm 11 does in its
# store. post-setup.sh then chowns the home and must not fail on it.
set -euo pipefail

store="$HOME/.local/share/e2e-store"
mkdir -p "$store"
ln -sfn "$store/missing" "$store/dangling"
