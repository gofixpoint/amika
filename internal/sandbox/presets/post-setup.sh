#!/bin/bash

# post-setup.sh runs after setup.sh as root.
# It restores /home/amika ownership in case the user hook wrote files as root.

set -euo pipefail

sudo chown -R amika:amika /home/amika
