#!/bin/bash
# Records final setuid binaries so the boot hook can restore their permissions.

set -euo pipefail

find / -xdev -perm -4000 -type f 2>/dev/null \
  > /usr/lib/amikad/setuid-manifest.txt || true
