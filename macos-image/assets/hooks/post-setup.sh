#!/usr/bin/env bash

# post-setup.sh runs after setup.sh as root, on a macOS rig.
# It restores /Users/amika ownership in case the user hook wrote files as root.

set -euo pipefail

chown -R amika:staff /Users/amika
