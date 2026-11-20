#!/bin/bash

# post-setup.sh runs after setup.sh as root.
# It restores the amika user's home ownership in case the user hook wrote
# files as root. The home is /home/amika on Amika's images and the provider's
# own home elsewhere (Instabox's is /data/home).

set -euo pipefail

amika_home="$(getent passwd amika | cut -d: -f6 || true)"
# -H follows the home itself when it is a symlink to the real directory.
# -h changes each symlink inside the home, not its target. Without it,
# chown fails on a dangling symlink, such as the ones pnpm 11 leaves
# in its store.
sudo chown -RHh amika:amika "${amika_home:-/home/amika}"
