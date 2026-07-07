#!/bin/bash
# Re-apply the setuid bit to binaries that carried it in the OCI image but lost
# it during Daytona's image->VM rootfs conversion (see base/Dockerfile). Runs as
# root from a systemd oneshot early in VM boot, before the Daytona agent starts
# and before the amika lifecycle uses sudo. On container sandboxes this never
# runs (systemd is not PID 1) and isn't needed (the setuid bits survive there).
set -u

manifest=/usr/lib/amikad/setuid-manifest.txt
[ -r "$manifest" ] || exit 0

while IFS= read -r path; do
  [ -n "$path" ] && [ -f "$path" ] && chmod u+s "$path" 2>/dev/null || true
done <"$manifest"

exit 0
