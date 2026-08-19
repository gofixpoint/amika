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

cd "$amika_agent_cwd"
# Pi has no web server, so ttyd serves its terminal UI over HTTP. `--writable`
# is what makes the session interactive rather than a read-only mirror, and the
# credential is what keeps the sandbox's shell off the open internet: the
# service URL is publicly routable.
#
# ttyd 1.7 takes the credential only as an argument, so it is visible in `ps`
# inside this sandbox. That is not a leak of anything new — every process here
# already runs as the user the terminal would hand out — but it is why the
# password is per-sandbox rather than an org-wide secret.
exec ttyd \
  --port "$pi_web_port" \
  --interface 0.0.0.0 \
  --credential "amika:${AMIKA_PI_WEB_PASSWORD}" \
  --writable \
  pi
