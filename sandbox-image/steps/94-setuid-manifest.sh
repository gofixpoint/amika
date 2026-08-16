#!/bin/bash

set -euo pipefail

find / -xdev -perm -4000 -type f 2>/dev/null \
  > /usr/lib/amikad/setuid-manifest.txt || true
