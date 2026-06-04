#!/bin/bash

# post-setup.sh runs after setup.sh as root.
# It restores /home/amika ownership in case the user hook wrote files as root.

set -euo pipefail

# Filtering with find instead of a blanket `chown -R` skips files that already
# have the right owner, avoiding ctime churn and overlayfs copy-ups.
sudo find /home/amika \( ! -user amika -o ! -group amika \) -exec chown -h amika:amika {} +
