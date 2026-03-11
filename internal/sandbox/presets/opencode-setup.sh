#!/bin/bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <working-directory> <port>" >&2
  exit 1
fi

amika_agent_cwd="$1"
opencode_web_port="$2"

cd "$amika_agent_cwd"
exec opencode web --port "$opencode_web_port" --mdns
