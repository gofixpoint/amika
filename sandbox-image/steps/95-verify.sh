#!/bin/bash

set -euo pipefail

: "${AMIKA_PRESET:?AMIKA_PRESET must be set}"

export AMIKA_PRESET
/usr/lib/amika-image/verify/run.sh build
