#!/bin/bash

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <working-directory> <public-port> <pi-web-port>" >&2
  exit 1
fi

amika_agent_cwd="$1"
public_port="$2"
pi_web_port="$3"

if [[ -z "${AMIKA_PI_WEB_PASSWORD:-}" ]]; then
  echo "ERROR: AMIKA_PI_WEB_PASSWORD must be set" >&2
  exit 1
fi

# Pi Web rejects any request whose Host header it was not told to trust
# ("Untrusted request", HTTP 403), and it accepts no wildcard — so without the
# sandbox's public hostname the server would answer nothing but 403s. Amika
# passes the host it minted for this service; refusing to start without it
# beats serving an endpoint that cannot work. The shim needs the same name to
# rebuild the identity the provider's proxy rewrites away, and takes the first
# entry because that is the URL Amika hands the user.
if [[ -z "${AMIKA_PI_WEB_ALLOWED_HOSTS:-}" ]]; then
  echo "ERROR: AMIKA_PI_WEB_ALLOWED_HOSTS must be set" >&2
  exit 1
fi
pi_web_public_host="${AMIKA_PI_WEB_ALLOWED_HOSTS%%,*}"

cd "$amika_agent_cwd"
# `--no-open` because there is no browser to launch here. `PI_WEB_PASSWORD`
# turns on HTTP Basic Auth with the fixed username `pi`; it travels in the
# environment rather than argv, so it is not visible in `ps` to anything else in
# the sandbox.
export PI_WEB_PASSWORD="$AMIKA_PI_WEB_PASSWORD"
export PI_WEB_ALLOWED_HOSTS="$AMIKA_PI_WEB_ALLOWED_HOSTS"

# Pi Web binds loopback and the shim owns the public port, because Pi Web's own
# API guard rejects every write whose Host and scheme the provider's proxy
# rewrote on the way in (see pi-web-shim.js). Only the shim's port is mapped by
# the provider, so loopback is all Pi Web needs.
pi-web --port "$pi_web_port" --hostname 127.0.0.1 --no-open &
pi_web_pid=$!

/usr/lib/amikad/pi-web-shim.js "$public_port" "$pi_web_port" "$pi_web_public_host" &
shim_pid=$!

# Neither half is useful alone: the shim without Pi Web serves 502s, and Pi Web
# on loopback is reachable by nobody. Take both down as soon as one exits so a
# failure closes the port instead of leaving a half-working endpoint behind.
trap 'kill "$pi_web_pid" "$shim_pid" 2>/dev/null || true' EXIT
wait -n
