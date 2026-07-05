#!/bin/bash

# docker-setup.sh starts the Docker daemon inside a DinD container.
# Called from pre-setup.sh when /usr/local/etc/amika/dind-enabled exists.

set -euo pipefail

DOCKERD_LOG="/var/log/amikad/dockerd.log"
DOCKERD_PID_FILE="/run/amikad/dockerd.pid"
DOCKER_READY_TIMEOUT=30

# A persistent-sandbox snapshot can capture the Docker and containerd pidfiles
# while the daemons are running. On a fresh boot from that snapshot neither is
# running, but the pidfiles survive pointing at PIDs that are no longer theirs
# (often reused by another process). A fresh dockerd then refuses to start
# ("ensure docker is not running or delete /var/run/docker.pid: process with PID
# N is still running"); and even past that, its managed containerd pidfile at
# /run/docker/containerd/containerd.pid would look alive, so dockerd times out on
# the dead socket — wedging the pre-setup hook on every boot from such a
# snapshot. Remove each stale pidfile when its daemon is not actually running.
if [ -f /var/run/docker.pid ] && ! pgrep -x dockerd >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
fi
if [ -f /run/docker/containerd/containerd.pid ] && ! pgrep -x containerd >/dev/null 2>&1; then
  rm -f /run/docker/containerd/containerd.pid
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
