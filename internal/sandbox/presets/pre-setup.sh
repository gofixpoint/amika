#!/bin/bash

OPENCODE_WEB_PORT=65535

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  amika_agent_cwd="$AMIKA_AGENT_CWD"
else
  amika_agent_cwd="/home/amika/workspace"
fi
cd "$amika_agent_cwd"

# Start opencode web server in the background, if opencode is installed.
if command -v opencode &> /dev/null; then
  mkdir -p /var/log/amika

  sudo -u amika \
    nohup env OPENCODE_SERVER_PASSWORD='fill-me-in' bash -c \
    "cd \"$amika_agent_cwd\" && exec opencode web --port \"$OPENCODE_WEB_PORT\" --mdns" \
    > /var/log/amika/opencode-web.log 2>&1 &

  echo "$!" > /run/amika/opencode-web.pid
  echo "$OPENCODE_WEB_PORT" > /run/amika/opencode-web.port
fi
