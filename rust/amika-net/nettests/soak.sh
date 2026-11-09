#!/bin/bash
# Keeps one SSH session open and records every end.
#   heartbeat: the remote prints a UTC time every 5 s (as the tunnel soak did)
#   idle:      the remote prints nothing (sleep); only keep-alives cross
# On an end, logs the session's age and last line, waits 30 s, reconnects.
#
# Usage: soak.sh <ssh-alias> <heartbeat|idle> <out-dir> [ssh args...]
set -uo pipefail
alias=$1; mode=$2; out=$3; shift 3
mkdir -p "$out"
drops="$out/drops.log"
n=0
case $mode in
  heartbeat) remote='while :; do date -u +%T; sleep 5; done' ;;
  idle) remote='sleep 172800' ;;
  *) echo "bad mode" >&2; exit 2 ;;
esac
while :; do
  n=$((n + 1))
  start=$(date -u +%s)
  echo "$(date -u +%FT%TZ) session $n start" >> "$drops"
  ssh "$@" "$alias" -- "$remote" > "$out/session-$n.log" 2> "$out/session-$n.err"
  code=$?
  end=$(date -u +%s)
  echo "$(date -u +%FT%TZ) session $n end: exit $code, age $((end - start))s, last line $(tail -1 "$out/session-$n.log" 2>/dev/null)" >> "$drops"
  sleep 30
done
