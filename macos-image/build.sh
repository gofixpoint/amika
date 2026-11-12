#!/bin/bash
# Builds a macOS image for Lume rigs. It clones a base VM that
# `lume create --unattended` made, runs steps/ in the clone as root over SSH,
# and leaves the clone stopped in Lume's default storage. The clone is the
# image: rigs are clones of it.
#
# Usage: macos-image/build.sh <base-vm> <image-vm>
#
# Environment:
#   AMIKAD_BIN  amikad for darwin/arm64. Default: build it from this checkout,
#               which needs Go. A copy outside a checkout (amika-hostd's
#               release) has no Go source, so there it must be set.
#   STEPS       Step names to run, for example "10-amika-user 60-amikad".
#               Default: every step, in order.
#   VERSIONS_ENV  The version pins the steps read. Default: versions.env
#               beside this script, which amika-hostd's release ships, else
#               this checkout's sandbox-image/versions.env.
#   NODE        A Node.js binary to read Lume's JSON with. amika-hostd sets
#               it to its own Node; without it the build uses python3, which
#               a Mac has only with the Xcode Command Line Tools.

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

# Checked before anything is cloned, so a copy run outside a checkout
# fails at once, naming what it lacks.
if [[ -z "${VERSIONS_ENV:-}" ]]; then
  if [[ -f "$here/versions.env" ]]; then
    VERSIONS_ENV="$here/versions.env"
  else
    VERSIONS_ENV="$repo/sandbox-image/versions.env"
  fi
fi
if [[ ! -f "$VERSIONS_ENV" ]]; then
  echo "no version pins at $VERSIONS_ENV; set VERSIONS_ENV" >&2
  exit 1
fi
if [[ -n "${AMIKAD_BIN:-}" ]]; then
  if [[ ! -f "$AMIKAD_BIN" ]]; then
    echo "AMIKAD_BIN names no file: $AMIKAD_BIN" >&2
    exit 1
  fi
elif [[ ! -d "$repo/go/cmd/amikad" ]]; then
  echo "no Go checkout at $repo to build amikad from; set AMIKAD_BIN to an amikad for darwin/arm64" >&2
  exit 1
fi

# The cleanup deletes the image VM on failure, so it must be one this run
# made, never a VM that was there before.
if lume get "$image" >/dev/null 2>&1; then
  echo "$image already exists; delete it or choose another name" >&2
  exit 1
fi

# Print field `ip` (the address once the VM runs, else empty) or `status`
# of the image VM, from `lume get`.
vm_field() {
  local json
  json="$(lume get "$image" --format json)"
  if [[ -n "${NODE:-}" ]]; then
    "$NODE" -e '
      const vm = JSON.parse(process.argv[2])[0];
      const field = process.argv[1];
      console.log(field === "ip"
        ? (vm.status === "running" && vm.ipAddress) || ""
        : vm.status);' "$1" "$json"
  else
    python3 -c '
import json, sys
vm = json.loads(sys.argv[2])[0]
if sys.argv[1] == "ip":
    print(vm.get("ipAddress") or "" if vm["status"] == "running" else "")
else:
    print(vm["status"])' "$1" "$json"
  fi
}

work="$(mktemp -d)"
cloned=false
built=false
cleanup() {
  # A half-built image must not be used as a template.
  if [[ "$cloned" == true && "$built" != true ]]; then
    lume stop "$image" --force >/dev/null 2>&1 || true
    lume delete "$image" --force >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# 1. Get amikad.
if [[ -z "${AMIKAD_BIN:-}" ]]; then
  AMIKAD_BIN="$work/amikad"
  GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
    go -C "$repo/go" build -o "$AMIKAD_BIN" ./cmd/amikad
fi
# 2. Clone the base VM and boot the clone with no display.
lume clone "$base" "$image"
cloned=true
lume run "$image" --detach --display none --vnc disabled \
  --log-file "$work/lume.log"
ip=""
for _ in $(seq 1 120); do
  ip="$(vm_field ip)"
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
# The steps use the Linux image's version pins.
guest 'cat > /tmp/amika-image/versions.env' <"$VERSIONS_ENV"
if [[ -z "${STEPS:-}" ]]; then
  for file in "$here"/steps/*.sh; do
    STEPS="${STEPS:-} $(basename "$file" .sh)"
  done
fi
for step in $STEPS; do
  echo "==> $step"
  # sudo -S reads the password from stdin. The step does not read stdin.
  printf '%s\n' "$AMIKA_IMAGE_PASSWORD" | guest \
    "sudo -S -p '' /bin/bash -c 'set -a; . /tmp/amika-image/versions.env;" \
    "set +a; exec /bin/bash /tmp/amika-image/steps/$step.sh'"
done

# 5. Remove the build files, and shut the image down from inside, so its
# disk is clean. `lume stop` ends the VM process when the guest does not
# stop in 10 s.
printf '%s\n' "$AMIKA_IMAGE_PASSWORD" | guest \
  "sudo -S -p '' sh -c 'rm -rf /tmp/amika-image && shutdown -h now'" || true
status=""
for _ in $(seq 1 120); do
  status="$(vm_field status)"
  [[ "$status" == stopped ]] && break
  sleep 1
done
[[ "$status" == stopped ]] || { echo "$image did not shut down" >&2; exit 1; }
built=true
echo "Built $image"
