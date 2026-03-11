#!/bin/bash

set -euo pipefail

OPENCODE_WEB_PORT=65535

AMIKA_STATE_DIR="/var/lib/amika"
AMIKA_CWD_FILE="$AMIKA_STATE_DIR/agent-cwd"

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  amika_agent_cwd="$AMIKA_AGENT_CWD"
elif [[ -f "$AMIKA_CWD_FILE" ]]; then
  amika_agent_cwd="$(cat "$AMIKA_CWD_FILE")"
else
  amika_agent_cwd="/home/amika/workspace"
fi

mkdir -p "$AMIKA_STATE_DIR"
echo "$amika_agent_cwd" > "$AMIKA_CWD_FILE"

cd "$amika_agent_cwd"

# Start opencode web server in the background, if opencode is installed.
if command -v opencode &> /dev/null; then
  if [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    echo "ERROR: OPENCODE_SERVER_PASSWORD must be set when opencode is installed" >&2
    exit 1
  fi

  mkdir -p /var/log/amika

  sudo -H -u amika \
    nohup env OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
    /opt/amika/opencode-setup.sh "$amika_agent_cwd" "$OPENCODE_WEB_PORT" \
    > /var/log/amika/opencode-web.log 2>&1 &

  echo "$!" > /run/amika/opencode-web.pid
  echo "$OPENCODE_WEB_PORT" > /run/amika/opencode-web.port
fi
