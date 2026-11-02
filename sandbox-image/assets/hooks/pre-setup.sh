#!/bin/bash

# pre-setup.sh runs first as root for Amika-managed container initialization.
# It creates fixed amikad/amika directories, remembers the agent working
# directory, switches into that directory, and optionally starts opencode web
# before the user-facing setup.sh hook runs.

set -euo pipefail

# Amika reserves container ports 60899-60999 for internal sandbox services.
# See docs/sandbox-configuration.md for the full port allocation table.
#   60999 — amikad daemon
#   60998 — OpenCode web UI
#   60997 — amikad's managed sshd (loopback; go/internal/constants)
#   60996 — Pi Web UI
#   60899-60995 — unassigned (reserved for future use)
OPENCODE_WEB_PORT=60998
PI_WEB_PORT=60996

AMIKA_STATE_DIR="/var/lib/amikad"
AMIKA_USER_STATE_DIR="/var/lib/amika"
AMIKA_LOG_DIR="/var/log/amikad"
AMIKA_USER_LOG_DIR="/var/log/amika"
AMIKA_RUN_DIR="/run/amikad"
AMIKA_USER_RUN_DIR="/run/amika"
AMIKA_TMP_DIR="/tmp/amikad"
AMIKA_USER_TMP_DIR="/tmp/amika"
AMIKA_CWD_FILE="$AMIKA_STATE_DIR/agent-cwd"

# Give amika everything under the given paths. A rig booted from a snapshot
# can carry symlinks whose owner cannot be changed: in a machine made from a
# smolvm pack, `chown -h` on a symlink the source machine created fails with
# ENOENT though the link is fine (seen on smolvm 1.22 and 1.28). A plain
# `chown -R` stops at the first one, so when it fails, recreate each such
# link, which makes it an ordinary one, and run it again. Only a rig's first
# boot from a snapshot takes the slow path, until it is snapshotted again.
own_by_amika() {
  chown -R amika:amika "$@" 2>/dev/null && return
  local link
  # `find` passes on only the links whose owner `chown -h` cannot change.
  # Each is replaced by renaming a new link over it, so a link is never
  # missing, even if making its replacement fails. The new link is made in a
  # fresh directory beside it, so its name collides with nothing, and all of
  # it relative to the link's directory, so no name or path grows past the
  # limits the link itself is within.
  while IFS= read -r -d '' link; do
    (
      cd -- "${link%/*}"
      local name="${link##*/}" target tmpdir
      # Command substitution strips trailing newlines, which a target may
      # end in; the `x` keeps them, and only readlink's own newline is cut.
      target="$(readlink -- "$name"; printf x)"
      target="${target%$'\nx'}"
      tmpdir="$(mktemp -d .amika-relink.XXXXXX)"
      ln -s -- "$target" "$tmpdir/link"
      mv -Tf -- "$tmpdir/link" "$name"
      rmdir -- "$tmpdir"
      chown -h -- amika:amika "$name"
    )
  done < <(find "$@" -type l ! -exec chown -h amika:amika {} \; -print0 2>/dev/null)
  chown -R amika:amika "$@"
}

# TODO(CVE-2026-98432): remove with ipv4-options-guard.sh once rig kernels
# are patched. systemd loads the guard at boot where it is PID 1; rigs without
# systemd, such as smolvm, get it only here. A rig whose kernel or sandbox
# refuses nftables (local Docker has no CAP_NET_ADMIN) still comes up, with
# a warning in this hook's log.
if ! /usr/lib/amikad/ipv4-options-guard.sh; then
  echo "WARNING: could not load the CVE-2026-98432 IPv4 options guard" >&2
fi

if [[ -n "${AMIKA_AGENT_CWD:-}" ]]; then
  amika_agent_cwd="$AMIKA_AGENT_CWD"
elif [[ -f "$AMIKA_CWD_FILE" ]]; then
  amika_agent_cwd="$(cat "$AMIKA_CWD_FILE")"
else
  amika_agent_cwd="/home/amika/workspace"
fi

mkdir -p \
  "$AMIKA_STATE_DIR" "$AMIKA_USER_STATE_DIR" \
  "$AMIKA_LOG_DIR" "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_RUN_DIR" "$AMIKA_USER_RUN_DIR" \
  "$AMIKA_TMP_DIR" "$AMIKA_USER_TMP_DIR"
own_by_amika \
  "$AMIKA_USER_STATE_DIR" \
  "$AMIKA_USER_LOG_DIR" \
  "$AMIKA_USER_RUN_DIR" \
  "$AMIKA_USER_TMP_DIR"
echo "$amika_agent_cwd" > "$AMIKA_CWD_FILE"

cd "$amika_agent_cwd"

# Agent hook registration is runtime user state. Reinstall it on every boot so
# mounted or restored homes remain self-healing without baking config into the
# image.
sudo -H -u amika /usr/local/bin/amikalog start

# Start opencode web server in the background by default when opencode is
# installed, unless Amika explicitly disables it. Output is redirected to
# /var/log/amikad/opencode-web.log because the server outlives this hook.
if command -v opencode &> /dev/null && [[ "${AMIKA_OPENCODE_WEB:-1}" != "0" ]]; then
  if [[ "${AMIKA_SANDBOX_PROVIDER:-}" == "local-docker" ]] && [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    echo "ERROR: OPENCODE_SERVER_PASSWORD must be set when opencode is installed" >&2
    exit 1
  fi

  # shellcheck disable=SC2024  # redirect is by root shell (intended); sudo switches the process user
  sudo -H -u amika \
    nohup env OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
    /usr/lib/amikad/opencode-setup.sh "$amika_agent_cwd" "$OPENCODE_WEB_PORT" \
    > "$AMIKA_LOG_DIR/opencode-web.log" 2>&1 &

  echo "$!" > "$AMIKA_RUN_DIR/opencode-web.pid"
  echo "$OPENCODE_WEB_PORT" > "$AMIKA_RUN_DIR/opencode-web.port"
fi

# Start Pi Web in the background when Amika asks for it. Unlike opencode web
# this is opt-in (`AMIKA_PI_WEB=1`): the UI drives an agent that runs commands
# in this sandbox over a public URL, so it only exists when the control plane
# supplies both a password and the hostname Pi Web should trust. Output is
# redirected to /var/log/amikad/pi-web.log because the server outlives this
# hook.
if command -v pi-web &> /dev/null && [[ "${AMIKA_PI_WEB:-0}" == "1" ]]; then
  if [[ -z "${AMIKA_PI_WEB_PASSWORD:-}" ]]; then
    echo "ERROR: AMIKA_PI_WEB_PASSWORD must be set when Pi Web is enabled" >&2
    exit 1
  fi
  if [[ -z "${AMIKA_PI_WEB_ALLOWED_HOSTS:-}" ]]; then
    echo "ERROR: AMIKA_PI_WEB_ALLOWED_HOSTS must be set when Pi Web is enabled" >&2
    exit 1
  fi

  # shellcheck disable=SC2024  # redirect is by root shell (intended); sudo switches the process user
  sudo -H -u amika \
    nohup env AMIKA_PI_WEB_PASSWORD="$AMIKA_PI_WEB_PASSWORD" \
    AMIKA_PI_WEB_ALLOWED_HOSTS="$AMIKA_PI_WEB_ALLOWED_HOSTS" \
    /usr/lib/amikad/pi-setup.sh "$amika_agent_cwd" "$PI_WEB_PORT" \
    > "$AMIKA_LOG_DIR/pi-web.log" 2>&1 &

  echo "$!" > "$AMIKA_RUN_DIR/pi-web.pid"
  echo "$PI_WEB_PORT" > "$AMIKA_RUN_DIR/pi-web.port"
fi

# Start Docker daemon if this is a DinD image (marker file baked into the image).
if [[ -f /usr/local/etc/amika/dind-enabled ]]; then
  /usr/lib/amikad/docker-setup.sh
fi

# Configure pnpm global bin directory so setup.sh can run `pnpm add -g`.
# Create as root first because Docker bind-mounts (e.g. agent credential files
# under ~/.local/) can leave intermediate directories root-owned, preventing
# the amika user from creating subdirectories.
PNPM_HOME="/home/amika/.local/share/pnpm"
mkdir -p "$PNPM_HOME"
own_by_amika /home/amika/.local
cat > /usr/local/etc/amikad/setup/env.sh <<'ENVEOF'
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
ENVEOF

own_by_amika /home/amika
