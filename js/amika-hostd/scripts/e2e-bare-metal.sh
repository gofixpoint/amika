#!/bin/bash
# End-to-end check of the bare_metal runtime on this machine, with no control
# plane and no network: real amika-hostd (from source, listen transport,
# loopback only), a real amikad, and the system sshd, all as the current
# user. It drives the machine API as the control plane does for a bare-metal
# rig, then logs in over the rig's own sshd with a throwaway key.
#
# Usage: scripts/e2e-bare-metal.sh AMIKAD_BINARY
#
# Build amikad first, from the repo root: `make build-amikad` (dist/amikad).
# Needs jq, openssl, ss, ssh and an sshd binary. Run from js/amika-hostd
# after `pnpm install`. Uses port 3920 (E2E_PORT to change it) and a
# throwaway directory under $HOME: sshd's StrictModes refuses state under a
# world-writable directory such as /tmp. Exits non-zero on any failure.
set -u
AMIKAD=$(cd "$(dirname "${1:?usage: $0 AMIKAD_BINARY}")" && pwd)/$(basename "$1")
HOSTD=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(mktemp -d "$HOME/.amika-bm-e2e.XXXXXX")
S="$ROOT"
PORT=${E2E_PORT:-3920}
URL="http://127.0.0.1:$PORT"
SECRET=$(openssl rand -hex 32)
RIGS="$URL/v0beta1/rigs"
pass=0; fail=0

check() { # name, condition-result (0 = pass)
  if [ "$2" = 0 ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi
}
api() { # method path [json]
  curl -sS -o "$S/body.json" -w '%{http_code}' -X "$1" "$URL$2" \
    -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
    ${3:+--data "$3"}
}
exec_rig() { # shell-command [stdin]
  local body
  body=$(jq -nc --arg c "$1" --arg s "${2:-}" \
    'if $s == "" then {command: ["/bin/sh","-c",$c], user: "root"} else {command: ["/bin/sh","-c",$c], user: "root", stdin: $s} end')
  api POST /v0beta1/rigs/laptop/exec "$body"
}

chmod 750 "$ROOT"
mkdir -p "$ROOT/config/amika-hostd" "$ROOT/state" "$ROOT/data"
cat > "$ROOT/config/amika-hostd/config.toml" <<EOF
hostname = "bm-e2e"
transport = "listen"
secret_store = "file"
port = $PORT
amikad_path = "$AMIKAD"

[runtimes.bare_metal]
EOF
ssh-keygen -q -t ed25519 -N '' -f "$ROOT/key" -C bm-e2e

if ss -ltnH "sport = :$PORT" | grep -q "127.0.0.1:$PORT"; then
  echo "port $PORT is in use; stop what holds it first, or set E2E_PORT" >&2
  rm -rf "$ROOT"; exit 2
fi
# Its own session, so the cleanup stops hostd and everything it started.
( cd "$HOSTD" && exec setsid env AMIKA_HOSTD_SECRET_KEY="$SECRET" XDG_CONFIG_HOME="$ROOT/config" \
    XDG_STATE_HOME="$ROOT/state" XDG_DATA_HOME="$ROOT/data" AMIKA_HOSTD_HOME="$ROOT/data/amika-hostd" \
    node_modules/.bin/tsx src/index.ts serve > "$ROOT/hostd.log" 2>&1 ) &
HOSTD_PID=$!
trap 'kill -TERM -- -$HOSTD_PID 2>/dev/null; sleep 2; kill -KILL -- -$HOSTD_PID 2>/dev/null; rm -rf "$ROOT"' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$URL/health" && break; sleep 1; done

code=$(api GET /health); check "health answers, naming runtimes ($code)" $([ "$code" = 200 ] && jq -e '.features | index("runtimes")' "$S/body.json" >/dev/null; echo $?)
code=$(api GET /capabilities)
check "capabilities report bare_metal as kind host, with resources and ssh_user" \
  $(jq -e --arg u "$(id -un)" '.runtimes | keys == ["bare_metal"] and .bare_metal.kind == "host" and .bare_metal.ssh_user == $u and .bare_metal.resources.vcpus > 0 and .bare_metal.snapshots == false' "$S/body.json" >/dev/null; echo $?)
jq -c . "$S/body.json"

code=$(api POST /v0beta1/rigs '{"name":"laptop","image":"bare-metal","runtime":"bare_metal","services":[{"name":"amikad","port":60999}]}')
check "create the rig on bare_metal ($code)" $([ "$code" = 201 ]; echo $?)
code=$(api POST /v0beta1/rigs '{"name":"laptop2","image":"bare-metal","runtime":"bare_metal","services":[{"name":"amikad","port":60999}]}')
check "a second bare_metal rig is refused with 409 ($code)" $([ "$code" = 409 ]; echo $?)
code=$(api POST /v0beta1/rigs '{"name":"vm","image":"coder","runtime":"smol"}')
check "a smol rig is refused: smol is off on this host ($code)" $([ "$code" = 400 ]; echo $?)
code=$(api GET /v0beta1/rigs)
check "list names the rig's runtime" $(jq -e '.machines[0].name == "laptop" and .machines[0].runtime == "bare_metal"' "$S/body.json" >/dev/null; echo $?)

code=$(exec_rig "id"); check "exec of anything but the allowlist is 403 ($code)" $([ "$code" = 403 ]; echo $?)
code=$(api GET /v0beta1/rigs/laptop/files/etc/passwd); check "file read is refused ($code)" $([ "$code" = 404 ]; echo $?)

TOKEN=$(openssl rand 32 | base64 -w0 | tr "+/" "-_" | tr -d "=")
code=$(exec_rig "amikad connect-token set" "$TOKEN"); check "connect-token set ($code, exit $(jq .exitCode "$S/body.json"))" $([ "$code" = 200 ] && [ "$(jq .exitCode "$S/body.json")" = 0 ]; echo $?)
code=$(exec_rig "amikad setup sshd --force-overwrite"); check "setup sshd ($code, exit $(jq .exitCode "$S/body.json"))" $([ "$(jq .exitCode "$S/body.json")" = 0 ]; echo $?)
[ "$(jq .exitCode "$S/body.json")" = 0 ] || jq -r .stderr "$S/body.json" | head -5
code=$(exec_rig "amikad authorized-keys set" "$(cat "$ROOT/key.pub")"); check "authorized-keys set ($code, exit $(jq .exitCode "$S/body.json"))" $([ "$(jq .exitCode "$S/body.json")" = 0 ]; echo $?)
code=$(exec_rig "amikad host-key show"); check "host-key show ($code)" $([ "$(jq .exitCode "$S/body.json")" = 0 ] && jq -r .stdout "$S/body.json" | grep -q ssh-; echo $?)
code=$(exec_rig "amikad serve --beta-no-relay --bg"); check "serve starts the supervised amikad ($code, exit $(jq .exitCode "$S/body.json"))" $([ "$(jq .exitCode "$S/body.json")" = 0 ]; echo $?)
[ "$(jq .exitCode "$S/body.json")" = 0 ] || { jq -r .stderr "$S/body.json"; tail -20 "$ROOT/hostd.log"; }

hc=$(curl -sS -o /dev/null -w '%{http_code}' "$RIGS/laptop/services/amikad/healthz" -H "X-Amika-Hostd-Key: $SECRET")
check "hostd routes to amikad's loopback listener ($hc)" $([ "$hc" = 200 ]; echo $?)
# The control plane hands out an SSH session only when amikad reports the
# service port it published, whatever loopback port amikad binds.
st=$(curl -sS "$RIGS/laptop/services/amikad/v1/status" -H "X-Amika-Hostd-Key: $SECRET")
check "amikad reports the service port the control plane checks ($st)" $(echo "$st" | jq -e '.mode == "beta_no_relay" and .port == 60999' >/dev/null; echo $?)

RIG_FILE=$(find "$ROOT/state" -name bare-metal-rig.json | head -1)
SSHD_PORT=$(jq .sshdPort "$RIG_FILE")
who=$(ssh -q -i "$ROOT/key" -p "$SSHD_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes "$(id -un)@127.0.0.1" 'id -un; id -u' 2>&1 | tr '\n' ' ')
check "ssh with the authorized key logs in as $(id -un), not root (got: $who)" $(echo "$who" | grep -q "^$(id -un) $(id -u)" && [ "$(id -u)" != 0 ]; echo $?)
listen=$(ss -ltnH "sport = :$SSHD_PORT" 2>/dev/null | awk '{print $4}')
check "the rig's sshd listens on loopback only ($listen)" $(echo "$listen" | grep -q '^127.0.0.1:'; echo $?)

code=$(api POST /v0beta1/rigs/laptop/stop); check "stop ($code)" $([ "$code" = 200 ]; echo $?)
sleep 1
st=$(ssh -q -i "$ROOT/key" -p "$SSHD_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=3 "$(id -un)@127.0.0.1" true 2>&1; echo $?)
check "ssh is refused once stopped" $([ "$st" != 0 ]; echo $?)
code=$(api DELETE /v0beta1/rigs/laptop); check "delete ($code)" $([ "$code" = 204 ] || [ "$code" = 200 ]; echo $?)
check "delete removed amikad's state and the record" $([ ! -e "$RIG_FILE" ] && [ ! -d "$(dirname "$RIG_FILE")/amikad" ]; echo $?)

echo "---- $pass passed, $fail failed"
if [ "$fail" != 0 ]; then echo "---- hostd log:"; tail -20 "$ROOT/hostd.log"; fi
[ "$fail" = 0 ]
