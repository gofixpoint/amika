#!/bin/bash

# pre-setup.sh runs first as root for Amika-managed container initialization.
# It creates fixed amikad/amika directories, remembers the agent working
# directory, switches into that directory, and optionally starts opencode web
# before the user-facing setup.sh hook runs.

set -euo pipefail

# Amika reserves container ports 60899-60999 for internal sandbox services.
# See docs/sandbox-configuration.md for the full port allocation table.
#   60999 — amikad daemon
#   60998 — OpenCode web UI
#   60899-60997 — unassigned (reserved for future use)
OPENCODE_WEB_PORT=60998

AMIKA_STATE_DIR="/var/lib/amikad"
AMIKA_USER_STATE_DIR="/var/lib/amika"
AMIKA_LOG_DIR="/var/log/amikad"
AMIKA_USER_LOG_DIR="/var/log/amika"
AMIKA_RUN_DIR="/run/amikad"
AMIKA_USER_RUN_DIR="/run/amika"
AMIKA_TMP_DIR="/tmp/amikad"
AMIKA_USER_TMP_DIR="/tmp/amika"
AMIKA_CWD_FILE="$AMIKA_STATE_DIR/agent-cwd"

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  amika_agent_cwd="$AMIKA_AGENT_CWD"
elif [[ -f "$AMIKA_CWD_FILE" ]]; then
  amika_agent_cwd="$(cat "$AMIKA_CWD_FILE")"
else
  amika_agent_cwd="/home/amika/workspace"
fi

mkdir -p \
  "$AMIKA_STATE_DIR" "$AMIKA_USER_STATE_DIR" \
  "$AMIKA_LOG_DIR" "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_RUN_DIR" "$AMIKA_USER_RUN_DIR" \
  "$AMIKA_TMP_DIR" "$AMIKA_USER_TMP_DIR"
chown -R amika:amika \
  "$AMIKA_USER_STATE_DIR" \
  "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_USER_RUN_DIR" \
  "$AMIKA_USER_TMP_DIR"
echo "$amika_agent_cwd" > "$AMIKA_CWD_FILE"

cd "$amika_agent_cwd"

# Start opencode web server in the background by default when opencode is
# installed, unless Amika explicitly disables it. Output is redirected to
# /var/log/amikad/opencode-web.log because the server outlives this hook.
if command -v opencode &> /dev/null && [[ "${AMIKA_OPENCODE_WEB:-1}" != "0" ]]; then
  if [[ "${AMIKA_SANDBOX_PROVIDER:-}" == "local-docker" ]] && [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    echo "ERROR: OPENCODE_SERVER_PASSWORD must be set when opencode is installed" >&2
    exit 1
  fi

  sudo -H -u amika \
    nohup env OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
    /usr/lib/amikad/opencode-setup.sh "$amika_agent_cwd" "$OPENCODE_WEB_PORT" \
    > "$AMIKA_LOG_DIR/opencode-web.log" 2>&1 &

  echo "$!" > "$AMIKA_RUN_DIR/opencode-web.pid"
  echo "$OPENCODE_WEB_PORT" > "$AMIKA_RUN_DIR/opencode-web.port"
fi
