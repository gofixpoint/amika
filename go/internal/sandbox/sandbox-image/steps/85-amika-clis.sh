#!/bin/bash

set -euo pipefail

: "${AMIKA_VERSION:?AMIKA_VERSION must be set}"
: "${AMIKALOG_VERSION:?AMIKALOG_VERSION must be set}"
: "${AMIKAD_VERSION:?AMIKAD_VERSION must be set}"

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
installer="$temporary_dir/install.sh"

curl -fsSL \
  "https://raw.githubusercontent.com/gofixpoint/amika/amika%40v${AMIKA_VERSION}/install.sh" \
  -o "$installer"
sh "$installer" --install-version "$AMIKA_VERSION"
sh "$installer" --component amikalog --install-version "$AMIKALOG_VERSION"
sh "$installer" --component amikad --install-version "$AMIKAD_VERSION"
