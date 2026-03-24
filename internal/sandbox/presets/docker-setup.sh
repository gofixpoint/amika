#!/bin/bash

# docker-setup.sh starts the Docker daemon inside a DinD container.
# Called from pre-setup.sh when /usr/local/etc/amika/dind-enabled exists.

set -euo pipefail

DOCKERD_LOG="/var/log/amikad/dockerd.log"
DOCKERD_PID_FILE="/run/amikad/dockerd.pid"
DOCKER_READY_TIMEOUT=30

# Start dockerd in the background.
nohup dockerd --storage-driver=overlay2 > "$DOCKERD_LOG" 2>&1 &
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
