#!/bin/bash

set -euo pipefail

OPENCODE_WEB_PORT=65535

AMIKA_STATE_DIR="/var/lib/amikad"
AMIKA_LOG_DIR="/var/log/amikad"
AMIKA_RUN_DIR="/run/amikad"
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

# Start opencode web server in the background by default when opencode is
# installed, unless Amika explicitly disables it.
if command -v opencode &> /dev/null && [[ "${AMIKA_OPENCODE_WEB:-1}" != "0" ]]; then
  if [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    echo "ERROR: OPENCODE_SERVER_PASSWORD must be set when opencode is installed" >&2
    exit 1
  fi

  mkdir -p "$AMIKA_LOG_DIR" "$AMIKA_RUN_DIR"

  sudo -H -u amika \
    nohup env OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
    /usr/lib/amikad/opencode-setup.sh "$amika_agent_cwd" "$OPENCODE_WEB_PORT" \
    > "$AMIKA_LOG_DIR/opencode-web.log" 2>&1 &

  echo "$!" > "$AMIKA_RUN_DIR/opencode-web.pid"
  echo "$OPENCODE_WEB_PORT" > "$AMIKA_RUN_DIR/opencode-web.port"
fi
