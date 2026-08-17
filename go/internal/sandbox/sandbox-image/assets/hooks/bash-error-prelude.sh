#!/bin/bash

# This file is sourced by Bash via BASH_ENV before each lifecycle hook runs.
# It installs an ERR trap that records the failing command, exit status, and
# best-effort line information into the hook log opened by run-hook.sh.

set -E

# shellcheck disable=SC2154  # status and line are assigned inside the trap
trap 'status=$?; if [[ $status -ne 0 ]]; then line="$(caller 0 2>/dev/null || true)"; echo "[$(date -Is)] ERROR ${AMIKA_HOOK_SCRIPT_NAME:-hook} exit=$status line=${line:-unknown} command=${BASH_COMMAND@Q}" >&2; fi' ERR
