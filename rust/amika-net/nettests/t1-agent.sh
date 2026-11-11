#!/bin/bash
# Test 1 through the per-user agent (as root on the client VM, after
# t1-netns.sh setup). Runs STREAMS sessions at once through one agent in the
# lap namespace, and switches networks SWITCHES times.
#
# Usage: t1-agent.sh <name> [switches] [interval-s]
#
# The target must send a line every 0.1 s, as the stream in t1-run.sh does,
# for example a `rig:<id>:<port>` that the host maps to a tick server.
#
# Set these (no defaults):
#   RUN_USER      the user who runs connect and its agent
#   AN_DIR        where t1-netns.sh, stamp.py and gaps.py live; results too
#   AN_BIN        the amika-net binary
#   CONNECT_ARGS  connect's flags: --key-file, --endpoint, --relay-url,
#                 --target, --agent-dir, --agent-log-file, endpoint options
# Optional: STREAMS (default 2).
set -uo pipefail
: "${RUN_USER:?}" "${AN_DIR:?}" "${AN_BIN:?}" "${CONNECT_ARGS:?}"
name=$1; n=${2:-10}; interval=${3:-15}; streams=${STREAMS:-2}
out=$AN_DIR/t1a-$name
mkdir -p "$out"; chown "$RUN_USER" "$out"
logs=()
for i in $(seq 1 "$streams"); do
  # A holder process, named for this run, keeps connect's stdin open.
  ip netns exec lap sudo -u "$RUN_USER" -H bash -c \
    "(exec -a t1a-hold-$name sleep infinity) | $AN_BIN connect $CONNECT_ARGS 2> $out/stream-$i.err | python3 $AN_DIR/stamp.py > $out/stream-$i.log" &
  logs+=("$out/stream-$i.log")
done
ready() { for l in "${logs[@]}"; do [ -f "$l" ] && [ "$(wc -l < "$l")" -ge 10 ] || return 1; done; }
for _ in $(seq 1 120); do ready && break; sleep 1; done
echo "$(date +%s.%N) streams-ready" >> "$out/marks.log"
sleep 10
for _ in $(seq 1 "$n"); do
  "$AN_DIR/t1-netns.sh" switch >> "$out/marks.log"
  sleep "$interval"
done
sleep 5
pkill -f "^t1a-hold-$name" 2>/dev/null
# The target never ends a stream, so stop this run's connects too.
pkill -f -- "connect $CONNECT_ARGS" 2>/dev/null
sleep 1
python3 "$AN_DIR/gaps.py" "$out/marks.log" "${logs[@]}" > "$out/summary.txt"
echo "done" >> "$out/summary.txt"
