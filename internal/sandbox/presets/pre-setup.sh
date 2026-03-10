#!/bin/bash

OPENCODE_WEB_PORT=65535

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  cd "$AMIKA_AGENT_CWD"
else
  cd '/home/amika/workspace'
fi

# Start opencode web server in the background, if opencode is installed.
if command -v opencode &> /dev/null; then
  mkdir -p /var/log/amika
  nohup env OPENCODE_SERVER_PASSWORD='fill-me-in' opencode web --port "$OPENCODE_WEB_PORT" --mdns > /var/log/amika/opencode-web.log 2>&1 &
  echo "$!" > /run/amika/opencode-web.pid
  echo "$OPENCODE_WEB_PORT" > /run/amika/opencode-web.port
fi
