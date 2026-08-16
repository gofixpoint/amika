#!/bin/bash
# Runs the build-time verification contract for the selected image preset.

set -euo pipefail

: "${AMIKA_PRESET:?AMIKA_PRESET must be set}"

export AMIKA_PRESET
/usr/lib/amika-image/verify/run.sh build

# Rosetta can create /root/.cache after the cache check while emulating AMD64.
# Remove it after successful verification so it never becomes image content.
rm -rf /root/.cache
