#!/bin/bash

# run-hook.sh is the stable entrypoint for all setup lifecycle hooks.
# It executes one hook script and injects a Bash ERR trap via BASH_ENV so
# command failures are written to the same log. setup.sh logs to
# /var/log/amika/setup.log so the amika user can write it, then mirrors the
# finished file to /var/log/amikad/setup.log. Root-owned hooks log directly to
# /var/log/amikad.

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <script>" >&2
  exit 64
fi

script_path="$1"
script_name="$(basename "$script_path")"
daemon_log_dir="/var/log/amikad"
daemon_log_file="$daemon_log_dir/${script_name%.sh}.log"
log_file="$daemon_log_file"
mirror_to_daemon=0

if [[ "$script_name" == "setup.sh" ]]; then
  log_file="/var/log/amika/setup.log"
  mirror_to_daemon=1
fi

mkdir -p "$(dirname "$log_file")"
touch "$log_file"

export AMIKA_HOOK_SCRIPT_NAME="$script_name"
export BASH_ENV="/usr/lib/amikad/bash-error-prelude.sh"

exec >>"$log_file" 2>&1

echo "[$(date -Is)] starting $script_name"

# Source the setup environment if it exists (written by pre-setup.sh).
if [[ -f /usr/local/etc/amikad/setup/env.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/etc/amikad/setup/env.sh
fi

# Change to the agent working directory for the user-facing setup hook only.
if [[ "$script_name" == "setup.sh" ]]; then
  _amika_cwd_file="/var/lib/amikad/agent-cwd"
  if [[ -f "$_amika_cwd_file" ]]; then
    cd "$(cat "$_amika_cwd_file")"
  fi
fi

set +e
"$script_path"
status=$?
set -e

echo "[$(date -Is)] finished $script_name exit=$status"

if [[ $mirror_to_daemon -eq 1 ]]; then
  set +e
  sudo mkdir -p "$daemon_log_dir"
  sudo cp "$log_file" "$daemon_log_file"
  copy_status=$?
  set -e

  if [[ $copy_status -ne 0 ]]; then
    echo "[$(date -Is)] failed to mirror $script_name log to $daemon_log_file" >&2
  fi
fi

exit "$status"
