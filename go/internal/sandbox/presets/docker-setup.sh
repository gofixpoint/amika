#!/bin/bash

# docker-setup.sh starts the Docker daemon inside a DinD container.
# Called from pre-setup.sh when /usr/local/etc/amika/dind-enabled exists.

set -euo pipefail

DOCKERD_LOG="/var/log/amikad/dockerd.log"
DOCKERD_PID_FILE="/run/amikad/dockerd.pid"
DOCKER_READY_TIMEOUT=30

# A persistent-sandbox snapshot can capture dockerd's own pidfile while the
# daemon is running. On a fresh boot from that snapshot dockerd is not running,
# but the pidfile survives pointing at a PID that is no longer dockerd (often
# reused by another process), so a fresh dockerd refuses to start ("ensure
# docker is not running or delete /var/run/docker.pid: process with PID N is
# still running") — wedging the pre-setup hook on every boot from such a
# snapshot. When no live dockerd is running the pidfile is stale, so remove it.
if [ -f /var/run/docker.pid ] && ! pgrep -x dockerd >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
fi

# Start dockerd in a new session so it survives process group cleanup
# when the calling hook (pre-setup.sh) exits.
setsid dockerd > "$DOCKERD_LOG" 2>&1 &
echo "$!" > "$DOCKERD_PID_FILE"

# Wait for the Docker socket to become available.
elapsed=0
until docker info > /dev/null 2>&1; do
  if [ "$elapsed" -ge "$DOCKER_READY_TIMEOUT" ]; then
    echo "ERROR: dockerd did not become ready within ${DOCKER_READY_TIMEOUT}s" >&2
    echo "  Check $DOCKERD_LOG for details." >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "dockerd is ready (took ${elapsed}s)."
