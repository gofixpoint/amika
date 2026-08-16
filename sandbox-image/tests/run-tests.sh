#!/bin/bash

set -euo pipefail

bundle_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "$bundle_dir/tests/check-bundle.py"
"$bundle_dir/verify/tests/run-tests.sh"
shellcheck \
  "$bundle_dir/build.sh" \
  "$bundle_dir/steps"/*.sh \
  "$bundle_dir/assets/hooks"/*.sh \
  "$bundle_dir/verify/run.sh" \
  "$bundle_dir/verify/checks"/*.sh \
  "$bundle_dir/verify/lib/check.sh"
