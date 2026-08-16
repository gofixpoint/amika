#!/bin/bash

set -u

manifest=/usr/lib/amikad/setuid-manifest.txt
[ -r "$manifest" ] || exit 0

while IFS= read -r path; do
  [ -n "$path" ] && [ -f "$path" ] && chmod u+s "$path" 2>/dev/null || true
done <"$manifest"

exit 0
