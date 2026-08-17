#!/bin/bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <coder|coder-dind> [image-tag]" >&2
  exit 64
fi

preset="$1"
case "$preset" in
  coder|coder-dind) ;;
  *) echo "unknown sandbox image preset: $preset" >&2; exit 64 ;;
esac

bundle_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$bundle_dir/.." && pwd)"
image_tag="${2:-amika/${preset}:latest}"

docker build \
  --file "$bundle_dir/generated/${preset}.Dockerfile" \
  --tag "$image_tag" \
  "$repository_root"
