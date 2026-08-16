#!/bin/bash

set -u

manifest=/usr/lib/amikad/setuid-manifest.txt
[ -r "$manifest" ] || exit 0

while IFS= read -r path; do
  if [ -n "$path" ] && [ -f "$path" ]; then
    chmod u+s "$path" 2>/dev/null || true
  fi
done <"$manifest"

exit 0
