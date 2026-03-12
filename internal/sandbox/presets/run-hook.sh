#!/bin/bash

# run-hook.sh is the stable entrypoint for all setup lifecycle hooks.
# It executes one hook script, routes stdout/stderr into
# /var/log/amikad/<hook>.log, and injects a Bash ERR trap via BASH_ENV so
# command failures are also written to the same log.

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <script>" >&2
  exit 64
fi

script_path="$1"
script_name="$(basename "$script_path")"
log_dir="/var/log/amikad"
log_file="$log_dir/${script_name%.sh}.log"

mkdir -p "$log_dir"
touch "$log_file"

export AMIKA_HOOK_SCRIPT_NAME="$script_name"
export BASH_ENV="/usr/lib/amikad/bash-error-prelude.sh"

exec >>"$log_file" 2>&1

echo "[$(date -Is)] starting $script_name"

set +e
"$script_path"
status=$?
set -e

echo "[$(date -Is)] finished $script_name exit=$status"
exit "$status"
