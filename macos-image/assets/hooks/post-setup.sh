#!/usr/bin/env bash

# post-setup.sh runs after setup.sh as root, on a macOS rig.
# It restores /Users/amika ownership in case the user hook wrote files as root.
# The folders macOS makes in a home are left out: macOS protects them even
# from root, and Amika does not write there.

set -euo pipefail

home=/Users/amika
prune=()
for dir in Library Desktop Documents Downloads Movies Music Pictures; do
  prune+=(-path "$home/$dir" -prune -o)
done
find "$home" "${prune[@]}" ! -user amika -exec chown -h amika:staff {} +
