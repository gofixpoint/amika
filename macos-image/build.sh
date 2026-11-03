#!/bin/bash
# Builds a macOS image for Lume rigs. It clones a base VM that
# `lume create --unattended` made, runs steps/ in the clone as root over SSH,
# and leaves the clone stopped in Lume's default storage. The clone is the
# image: rigs are clones of it.
#
# Usage: macos-image/build.sh <base-vm> <image-vm>
#
# Environment:
#   AMIKAD_BIN  amikad for darwin/arm64. Default: build it from this checkout.
#   STEPS       Step names to run, for example "10-amika-user 60-amikad".
#               Default: every step, in order.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <base-vm> <image-vm>" >&2
  exit 2
fi
base="$1"
image="$2"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
bootstrap_user=lume
export AMIKA_IMAGE_PASSWORD=lume

work="$(mktemp -d)"
built=false
cleanup() {
  # A half-built image must not be used as a template.
  if [[ "$built" != true ]] && lume get "$image" >/dev/null 2>&1; then
    lume stop "$image" --force >/dev/null 2>&1 || true
    lume delete "$image" --force >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# 1. Get amikad and the pinned versions.
if [[ -z "${AMIKAD_BIN:-}" ]]; then
  AMIKAD_BIN="$work/amikad"
  GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
    go -C "$repo/go" build -o "$AMIKAD_BIN" ./cmd/amikad
fi
# shellcheck disable=SC1091  # pins shared with the Linux image
source "$repo/sandbox-image/versions.env"

# 2. Clone the base VM and boot the clone with no display.
lume clone "$base" "$image"
lume run "$image" --detach --display none --vnc disabled \
  --log-file "$work/lume.log"
ip=""
for _ in $(seq 1 120); do
  ip="$(lume get "$image" --format json | python3 -c \
    'import json, sys; vm = json.load(sys.stdin)[0]; print(vm.get("ipAddress") or "" if vm["status"] == "running" else "")')"
  [[ -n "$ip" ]] && break
  sleep 1
done
[[ -n "$ip" ]] || { echo "$image did not get an IP address" >&2; exit 1; }

# 3. Log in with the base VM's password. The image keeps it: the rig's SSH
# bootstrap uses it one time, then turns password login off.
# shellcheck disable=SC2016  # the guest's askpass expands it
printf '#!/bin/sh\nprintf "%%s\\n" "$AMIKA_IMAGE_PASSWORD"\n' >"$work/askpass"
chmod 700 "$work/askpass"
guest() {
  SSH_ASKPASS="$work/askpass" SSH_ASKPASS_REQUIRE=force \
    ssh -F /dev/null -T -o LogLevel=ERROR -o ConnectTimeout=10 \
    -o UserKnownHostsFile="$work/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new \
    -o PubkeyAuthentication=no "$bootstrap_user@$ip" "$@"
}
for _ in $(seq 1 120); do
  guest true 2>/dev/null && break
  sleep 1
done
guest true

# 4. Copy the steps and amikad in, and run each step as root.
tar -C "$here" -cf - steps assets | guest \
  'rm -rf /tmp/amika-image && mkdir /tmp/amika-image && tar -C /tmp/amika-image -xf -'
guest 'cat > /tmp/amika-image/amikad' <"$AMIKAD_BIN"
if [[ -z "${STEPS:-}" ]]; then
  for file in "$here"/steps/*.sh; do
    STEPS="${STEPS:-} $(basename "$file" .sh)"
  done
fi
for step in $STEPS; do
  echo "==> $step"
  # sudo -S reads the password from stdin. The step does not read stdin.
  printf '%s\n' "$AMIKA_IMAGE_PASSWORD" | guest \
    "sudo -S -p '' env NODE_VERSION=$NODE_VERSION NPM_VERSION=$NPM_VERSION" \
    "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION CODEX_VERSION=$CODEX_VERSION" \
    "/bin/bash /tmp/amika-image/steps/$step.sh"
done

# 5. Remove the build files, and shut the image down.
printf '%s\n' "$AMIKA_IMAGE_PASSWORD" | guest \
  "sudo -S -p '' rm -rf /tmp/amika-image"
lume stop "$image"
built=true
echo "Built $image"
