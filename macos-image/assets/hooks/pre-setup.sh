#!/usr/bin/env bash

# pre-setup.sh runs as root before setup.sh, on a macOS rig. It is the Linux
# hook (sandbox-image/assets/hooks/pre-setup.sh) less what a macOS rig does
# not have: Docker, Pi Web, and the Linux kernel guard.

set -euo pipefail

OPENCODE_WEB_PORT=60998

AMIKA_STATE_DIR="/var/lib/amikad"
AMIKA_USER_STATE_DIR="/var/lib/amika"
AMIKA_LOG_DIR="/var/log/amikad"
AMIKA_USER_LOG_DIR="/var/log/amika"
AMIKA_RUN_DIR="/var/run/amikad"
AMIKA_USER_RUN_DIR="/var/run/amika"
AMIKA_TMP_DIR="/tmp/amikad"
AMIKA_USER_TMP_DIR="/tmp/amika"
AMIKA_CWD_FILE="$AMIKA_STATE_DIR/agent-cwd"

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  amika_agent_cwd="$AMIKA_AGENT_CWD"
elif [[ -f "$AMIKA_CWD_FILE" ]]; then
  amika_agent_cwd="$(cat "$AMIKA_CWD_FILE")"
else
  amika_agent_cwd="/Users/amika/workspace"
fi

mkdir -p \
  "$AMIKA_STATE_DIR" "$AMIKA_USER_STATE_DIR" \
  "$AMIKA_LOG_DIR" "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_RUN_DIR" "$AMIKA_USER_RUN_DIR" \
  "$AMIKA_TMP_DIR" "$AMIKA_USER_TMP_DIR"
chown -R amika:staff \
  "$AMIKA_USER_STATE_DIR" "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_USER_RUN_DIR" "$AMIKA_USER_TMP_DIR"

echo "$amika_agent_cwd" > "$AMIKA_CWD_FILE"
cd "$amika_agent_cwd"

if command -v opencode &> /dev/null && [[ "${AMIKA_OPENCODE_WEB:-1}" != "0" ]]; then
  # shellcheck disable=SC2024  # root writes the log, as on Linux
  sudo -H -u amika \
    nohup env PATH="$PATH" OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}" \
    /usr/local/lib/amikad/opencode-setup.sh "$amika_agent_cwd" "$OPENCODE_WEB_PORT" \
    > "$AMIKA_LOG_DIR/opencode-web.log" 2>&1 < /dev/null &
  echo "$!" > "$AMIKA_RUN_DIR/opencode-web.pid"
  echo "$OPENCODE_WEB_PORT" > "$AMIKA_RUN_DIR/opencode-web.port"
fi

# Made as amika, not chowned after: a recursive chown of the home folder
# fails on the parts of ~/Library that macOS protects even from root.
sudo -u amika mkdir -p /Users/amika/.local/share/pnpm
mkdir -p /usr/local/etc/amikad/setup
cat > /usr/local/etc/amikad/setup/env.sh <<'ENVEOF'
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
ENVEOF
