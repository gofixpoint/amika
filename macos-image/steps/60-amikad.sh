#!/bin/bash
# Installs amikad and its launchd job. The job file is not in
# /Library/LaunchDaemons, so launchd does not start amikad at boot: a rig
# must get new credentials before the SSH bridge starts. After provisioning
# sets them, it copies the file to /Library/LaunchDaemons, loads it with
# `launchctl bootstrap system`, and removes the copy. `bootstrap` refuses a
# file outside /Library/LaunchDaemons, and launchd keeps a loaded job
# without its file.

set -euo pipefail

install -d -m 755 -o root -g wheel /usr/local/bin /usr/local/lib/amikad
install -m 755 -o root -g wheel /tmp/amika-image/amikad /usr/local/bin/amikad
install -m 644 -o root -g wheel \
  /tmp/amika-image/assets/com.amika.amikad.plist \
  /usr/local/lib/amikad/com.amika.amikad.plist
plutil -lint /usr/local/lib/amikad/com.amika.amikad.plist >/dev/null

# amikad's secure writes refuse a symlink in a path, and /var is a symlink to
# /private/var. So make the real directory that amikad writes to.
install -d -m 700 -o root -g wheel /private/var/lib/amikad
install -d -m 755 -o root -g wheel /private/var/log/amikad
