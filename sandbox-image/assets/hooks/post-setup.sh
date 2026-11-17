#!/bin/bash

# post-setup.sh runs after setup.sh as root.
# It restores the amika user's home ownership in case the user hook wrote
# files as root. The home is /home/amika on Amika's images and the provider's
# own home elsewhere (Instabox's is /data/home).

set -euo pipefail

amika_home="$(getent passwd amika | cut -d: -f6 || true)"
# -H follows the home itself when it is a symlink to the real directory.
sudo chown -RH amika:amika "${amika_home:-/home/amika}"
