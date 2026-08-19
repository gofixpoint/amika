#!/bin/bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <working-directory> <port>" >&2
  exit 1
fi

amika_agent_cwd="$1"
pi_web_port="$2"

if [[ -z "${AMIKA_PI_WEB_PASSWORD:-}" ]]; then
  echo "ERROR: AMIKA_PI_WEB_PASSWORD must be set" >&2
  exit 1
fi

# Pi Web rejects any request whose Host header it was not told to trust
# ("Untrusted request", HTTP 403), and it accepts no wildcard — so without the
# sandbox's public hostname the server would answer nothing but 403s. Amika
# passes the host it minted for this service; refusing to start without it
# beats serving an endpoint that cannot work.
if [[ -z "${AMIKA_PI_WEB_ALLOWED_HOSTS:-}" ]]; then
  echo "ERROR: AMIKA_PI_WEB_ALLOWED_HOSTS must be set" >&2
  exit 1
fi

cd "$amika_agent_cwd"
# `--no-open` because there is no browser to launch here, and 0.0.0.0 so the
# provider's port mapping can reach it. `PI_WEB_PASSWORD` turns on HTTP Basic
# Auth with the fixed username `pi`; it travels in the environment rather than
# argv, so it is not visible in `ps` to anything else in the sandbox.
export PI_WEB_PASSWORD="$AMIKA_PI_WEB_PASSWORD"
export PI_WEB_ALLOWED_HOSTS="$AMIKA_PI_WEB_ALLOWED_HOSTS"
exec pi-web --port "$pi_web_port" --hostname 0.0.0.0 --no-open
