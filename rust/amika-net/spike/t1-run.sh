#!/bin/bash
# Test 1 run (as root on the client VM, after t1-netns.sh setup).
# Streams a line every 0.1 s over SSH inside the lap namespace, over iroh
# and over plain SSH, and switches networks SWITCHES times.
#
# Usage: t1-run.sh <name> <iroh-ssh-alias> [switches] [interval-s]
#
# Set RUN_USER (the user whose ~/.ssh/config has the aliases) and AN_DIR
# (where t1-netns.sh, stamp.py and gaps.py live; results go there too).
# The plain-SSH control uses the alias `plain`.
set -uo pipefail
: "${RUN_USER:?}" "${AN_DIR:?}"
name=$1; alias=$2; n=${3:-20}; interval=${4:-30}
an=$AN_DIR
out=$an/t1-$name
mkdir -p "$out"; chown "$RUN_USER" "$out"
stream() { # <alias> <label>
  ip netns exec lap sudo -u $RUN_USER -H bash -c \
    "ssh $1 'while :; do date +%s.%N; sleep 0.1; done' 2> $out/stream-$2.err | python3 $an/stamp.py > $out/stream-$2.log" &
}
stream "$alias" iroh
stream plain plain
# Start switching only when both streams flow.
for _ in $(seq 1 120); do
  [ "$(wc -l < "$out/stream-iroh.log")" -ge 10 ] && [ "$(wc -l < "$out/stream-plain.log")" -ge 10 ] && break
  sleep 1
done
echo "$(date +%s.%N) streams-ready iroh=$(wc -l < "$out/stream-iroh.log") plain=$(wc -l < "$out/stream-plain.log")" >> "$out/marks.log"
sleep 10
for _ in $(seq 1 "$n"); do
  "$an/t1-netns.sh" switch >> "$out/marks.log"
  sleep "$interval"
done
sleep 5
for p in $(pgrep -f "[d]ate .%s.%N; sleep 0.1"); do kill "$p" 2>/dev/null; done
sleep 1
python3 "$an/gaps.py" "$out/marks.log" "$out/stream-iroh.log" "$out/stream-plain.log" > "$out/summary.txt"
echo "done" >> "$out/summary.txt"
