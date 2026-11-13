#!/bin/sh
set -eu
# Nothing this script creates should be writable by the group. Ubuntu's
# default umask (002) would leave directories such as ~/.local group-writable,
# and sshd's StrictModes then refuses a bare-metal host's amikad state under
# them.
umask 022

# This script installs only what amika-hostd needs to run: the bundle (one
# JavaScript file) in HOSTD_HOME (default $XDG_DATA_HOME/amika-hostd), a
# Node.js to run it, and a launcher on INSTALL_DIR. `amika-hostd setup`
# installs what each runtime needs (smolvm, Lume, amikad) and writes the
# config.

INSTALL_DIR="${AMIKA_INSTALL_DIR:-/usr/local/bin}"
GITHUB_REPO="gofixpoint/amika"
# TODO(KAPRO-1059): v0.4.0 bundles Hono and follow-redirects releases with
# known advisories. Point this at the first release built from a main that
# has the fixes once it is published.
DEFAULT_VERSION="0.8.0"
INSTALL_VERSION=""
DRY_RUN=false

HOSTD_HOME="${AMIKA_HOSTD_HOME:-${XDG_DATA_HOME:-${HOME:-}/.local/share}/amika-hostd}"
# A system node on this major or newer is used as it is: keeping it patched is
# its owner's job.
NODE_MIN_MAJOR=22
# The oldest release of each Node.js major this installer will download: the
# October 2026 security releases, which fix TLS hostname checks and the Brotli
# decoder and drop eMudhra's compromised CAs from the bundled store. A private
# node older than its major's entry is replaced.
NODE_MIN_VERSIONS="22.23.4 24.22.1 26.12.1"
NODE_VERSION="${AMIKA_HOSTD_NODE_VERSION:-24.22.1}"
NODE_VERSION="${NODE_VERSION#v}"
NODE_DIST_URL="${AMIKA_HOSTD_NODE_DIST_URL:-https://nodejs.org/dist}"
NODE_DIST_URL="${NODE_DIST_URL%/}"
UNINSTALL=false
PURGE=false
ASSUME_YES=false

usage() {
  cat <<EOF
install-amika-hostd.sh — install the amika-hostd BYOC host daemon

Installs amika-hostd from its GitHub release, and the Node.js ${NODE_MIN_MAJOR}+ it
runs on. It uses the system node if it is new enough, and otherwise downloads
Node.js ${NODE_VERSION} into ${HOSTD_HOME}/node. Then run \`amika-hostd setup\`:
it asks which runtimes this host runs, and installs what each one needs.

Supported hosts: Linux x86_64 or arm64, and macOS.

Usage:
  sh install-amika-hostd.sh [--help] [--install-version VERSION] [--dry-run]
  sh install-amika-hostd.sh --uninstall [--purge] [--yes] [--dry-run]

Flags:
  --install-version     Install a specific version (default: ${DEFAULT_VERSION})
  --dry-run             Show what would be done without downloading or installing
  --uninstall           Remove amika-hostd instead of installing it. Finds
                        amika-hostd on PATH (or in AMIKA_INSTALL_DIR if set)
                        and asks you to confirm. Runs \`amika-hostd
                        uninstall\`, which stops the daemon and deletes what
                        its runtimes installed. Then deletes the launcher and
                        its files directory (including the private Node.js),
                        and asks whether to remove the config and state
                        directory, and the keychain secrets. If it finds the
                        wrong install, answer no and set AMIKA_INSTALL_DIR.
  --purge               With --uninstall: remove the config, state directory
                        and keychain secrets without asking
  --yes, -y             With --uninstall: answer yes to every yes/no question
                        (needed when there is no terminal)

No flag deletes smolvm or the macOS images: only typing a phrase at their
questions does.

Environment variables:
  AMIKA_INSTALL_DIR          Launcher directory (default: /usr/local/bin)
  AMIKA_HOSTD_HOME           amika-hostd's files and private Node.js
                             (default: \$XDG_DATA_HOME/amika-hostd, which is
                             ~/.local/share/amika-hostd by default)
  AMIKA_HOSTD_NODE_VERSION   Node.js version to download when the system node
                             is missing or too old (default: ${NODE_VERSION});
                             must be a patched release ($(node_floors_text))
  AMIKA_RELEASE_URL          Testing only: fetch the archive and checksums.txt
                             from this base URL (e.g. file:///path/to/dir)
                             instead of the GitHub release
  AMIKA_HOSTD_NODE_DIST_URL  Testing only: fetch Node.js from this base URL
                             instead of https://nodejs.org/dist

Examples:
  curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
  sh install-amika-hostd.sh --install-version 0.1.0
  AMIKA_INSTALL_DIR=~/.local/bin sh install-amika-hostd.sh
EOF
}

main() {
  parse_args "$@"
  if [ "$UNINSTALL" = "true" ]; then
    uninstall_hostd
    exit 0
  fi
  if [ "$PURGE" = "true" ] || [ "$ASSUME_YES" = "true" ]; then
    echo "Error: --purge and --yes only apply with --uninstall" >&2
    exit 1
  fi
  check_node_version
  detect_platform

  VERSION="${INSTALL_VERSION:-$DEFAULT_VERSION}"
  VERSION="${VERSION#v}"
  TAG="amika-hostd@v${VERSION}"
  echo "Installing amika-hostd release: ${TAG}"

  # The bundle is plain JavaScript: one archive serves every platform.
  ARCHIVE_BASE="amika-hostd_${VERSION}"
  ARCHIVE_NAME="${ARCHIVE_BASE}.tar.gz"
  RELEASE_URL="${AMIKA_RELEASE_URL:-https://github.com/${GITHUB_REPO}/releases/download/${TAG}}"
  DOWNLOAD_URL="${RELEASE_URL}/${ARCHIVE_NAME}"
  CHECKSUMS_URL="${RELEASE_URL}/checksums.txt"

  if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — no changes will be made."
    echo "  Tag:          ${TAG}"
    echo "  Platform:     ${OS}/${ARCH}"
    echo "  Download URL: ${DOWNLOAD_URL}"
    echo "  Checksums:    ${CHECKSUMS_URL}"
    echo "  Install to:   ${INSTALL_DIR}/amika-hostd"
    describe_plan
    exit 0
  fi

  download_and_extract
  install_hostd
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --help|-h)
        usage
        exit 0
        ;;
      --install-version)
        if [ "$#" -lt 2 ]; then
          echo "Error: --install-version requires a value" >&2
          exit 1
        fi
        INSTALL_VERSION="$2"
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        ;;
      --uninstall)
        UNINSTALL=true
        ;;
      --purge)
        PURGE=true
        ;;
      --yes|-y)
        ASSUME_YES=true
        ;;
      *)
        echo "Unknown argument: $arg" >&2
        usage >&2
        exit 1
        ;;
    esac
    shift
  done
}

# Ask a yes/no question on the terminal (stdin may be the script itself when
# piped from curl). Defaults to no, and to no without a terminal.
ask() {
  { : </dev/tty; } 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r reply </dev/tty || reply=""
  case "$reply" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Like ask, but --yes answers yes, and a missing terminal is an error.
confirm() {
  if [ "$ASSUME_YES" = "true" ]; then
    return 0
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    echo "Error: no terminal to ask: ${1}" >&2
    echo "Pass --yes to answer yes to every yes/no question." >&2
    exit 1
  fi
  ask "$1"
}

# Print the directory HOSTD_HOME that a launcher points at, read from the
# `exec <node> <HOSTD_HOME>/amika-hostd.mjs "$@"` line install_hostd wrote.
# Prints nothing when the launcher is not in that shape.
launcher_hostd_home() {
  bundle="$(sed -n "s/^exec '[^']*' '\([^']*\)\/amika-hostd\.mjs' .*/\1/p" "$1" 2>/dev/null | head -n 1)"
  printf '%s' "$bundle"
}

# Remove a directory the user owns, reporting it either way.
remove_dir() {
  if [ -d "$1" ]; then
    rm -rf "$1"
    echo "Removed ${1}"
  else
    echo "Nothing at ${1}"
  fi
}

# The two secrets `amika-hostd setup` keeps, as account names under service
# `amika-hostd` (src/internal/credentials.ts).
SECRET_ACCOUNTS="api-key secret-key"

# Delete the keychain items, tolerating ones that are not there. The file store
# keeps its API key in CONFIG_DIR/api-key and its secret key in config.toml,
# so those go with the config directory.
remove_secrets() {
  case "$(uname -s)" in
    Darwin)
      if command -v security >/dev/null 2>&1; then
        keychain="$(security login-keychain 2>/dev/null | sed 's/^[[:space:]]*"\(.*\)"$/\1/')"
        for account in $SECRET_ACCOUNTS; do
          if security delete-generic-password -s amika-hostd -a "$account" ${keychain:+"$keychain"} >/dev/null 2>&1; then
            echo "Removed keychain item amika-hostd/${account}"
          else
            echo "No keychain item amika-hostd/${account}"
          fi
        done
      fi
      ;;
    *)
      if command -v secret-tool >/dev/null 2>&1; then
        for account in $SECRET_ACCOUNTS; do
          if secret-tool clear service amika-hostd account "$account" >/dev/null 2>&1; then
            echo "Cleared Secret Service item amika-hostd/${account}"
          else
            echo "Could not clear Secret Service item amika-hostd/${account}" >&2
          fi
        done
      else
        echo "secret-tool not found; remove the amika-hostd items from your keyring yourself" >&2
      fi
      ;;
  esac
  if [ -e "${CONFIG_DIR}/api-key" ]; then
    rm -f "${CONFIG_DIR}/api-key"
    echo "Removed ${CONFIG_DIR}/api-key"
  fi
}

# Undo install_hostd: `amika-hostd uninstall` stops the daemon and deletes
# what its runtimes installed, then this deletes the launcher and HOSTD_HOME.
# The launcher is found on PATH (unless AMIKA_INSTALL_DIR names it) and the
# user confirms it. The config, state directory and keychain secrets are
# asked about, or removed outright by --purge. The host's Amika registration
# is never removed.
uninstall_hostd() {
  config_paths
  CONFIG_DIR="$(dirname "$CONFIG_PATH")"
  STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/amika-hostd"

  if [ -n "${AMIKA_INSTALL_DIR:-}" ]; then
    DEST_PATH="${INSTALL_DIR}/amika-hostd"
  else
    DEST_PATH="$(command -v amika-hostd 2>/dev/null || true)"
    [ -n "$DEST_PATH" ] || DEST_PATH="${INSTALL_DIR}/amika-hostd"
  fi

  if [ ! -e "$DEST_PATH" ] && [ ! -L "$DEST_PATH" ]; then
    echo "amika-hostd was not found at ${DEST_PATH}." >&2
    echo "If it is installed elsewhere, set AMIKA_INSTALL_DIR to its directory" >&2
    echo "(and AMIKA_HOSTD_HOME if you changed that) and run this again." >&2
    exit 1
  fi

  # An explicit AMIKA_HOSTD_HOME wins; otherwise trust what the launcher says,
  # and fall back to the default location.
  if [ -z "${AMIKA_HOSTD_HOME:-}" ]; then
    from_launcher="$(launcher_hostd_home "$DEST_PATH")"
    [ -z "$from_launcher" ] || HOSTD_HOME="$from_launcher"
  fi

  # HOSTD_HOME is deleted recursively; refuse values that could be a disaster.
  case "$HOSTD_HOME" in
    ""|/|"$HOME"|"$HOME"/)
      echo "Error: refusing to remove unsafe amika-hostd home: '${HOSTD_HOME}'" >&2
      exit 1
      ;;
  esac

  echo "Found amika-hostd:"
  echo "  Launcher: ${DEST_PATH}"
  echo "  Files:    ${HOSTD_HOME}"

  if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — no changes will be made."
    "$DEST_PATH" uninstall --dry-run || true
    echo "  Would remove:               ${DEST_PATH}"
    echo "  Would remove:               ${HOSTD_HOME}"
    if [ "$PURGE" = "true" ]; then
      echo "  Would remove:               ${CONFIG_DIR}"
      echo "  Would remove:               ${STATE_DIR}"
      echo "  Would remove:               the amika-hostd keychain secrets"
    else
      echo "  Would ask about:            ${CONFIG_DIR} and ${STATE_DIR}"
      echo "  Would ask about:            the amika-hostd keychain secrets"
    fi
    uninstall_notes
    return 0
  fi

  if ! confirm "Uninstall this amika-hostd?"; then
    echo "Not uninstalling. If that is the wrong install, set AMIKA_INSTALL_DIR" >&2
    echo "to the directory holding the right launcher (and AMIKA_HOSTD_HOME if" >&2
    echo "you changed that) and run this again." >&2
    exit 1
  fi

  # Decide about the config and state up front so nothing is half-done if the
  # user walks away from a later question.
  remove_user_data=false
  remove_secrets_too=false
  if [ "$PURGE" = "true" ]; then
    remove_user_data=true
    remove_secrets_too=true
  else
    if confirm "Also remove the config (${CONFIG_DIR}) and state directory (${STATE_DIR})?"; then
      remove_user_data=true
    fi
    if confirm "Also remove the amika-hostd secrets (API key, secret key) from your keychain?"; then
      remove_secrets_too=true
    fi
  fi

  # Before the config and state go: it reads them to find the Lume rigs. Its
  # questions need the terminal, which stdin may not be when this script is
  # piped from curl. It asks about the Lume rigs itself, unless --yes.
  yes_flag=""
  [ "$ASSUME_YES" = "true" ] && yes_flag="--yes"
  if { : </dev/tty; } 2>/dev/null; then
    "$DEST_PATH" uninstall $yes_flag </dev/tty || hostd_uninstall_failed
  else
    "$DEST_PATH" uninstall $yes_flag </dev/null || hostd_uninstall_failed
  fi

  if [ -w "$(dirname "$DEST_PATH")" ]; then
    rm -f "$DEST_PATH"
  else
    echo "Removing ${DEST_PATH} (requires sudo)..."
    sudo rm -f "$DEST_PATH"
  fi
  echo "Removed ${DEST_PATH}"

  remove_dir "$HOSTD_HOME"
  if [ "$remove_secrets_too" = "true" ]; then
    remove_secrets
  fi
  if [ "$remove_user_data" = "true" ]; then
    remove_dir "$CONFIG_DIR"
    remove_dir "$STATE_DIR"
  fi

  echo ""
  echo "amika-hostd uninstalled."
  uninstall_notes
}

hostd_uninstall_failed() {
  echo "Warning: 'amika-hostd uninstall' failed; stop the daemon, and delete its Lume rigs and smolvm, yourself" >&2
}

# What an uninstall never removes.
uninstall_notes() {
  echo ""
  echo "Not removed; delete them yourself if you want them gone:"
  [ ! -e "$SYSTEM_CONFIG_PATH" ] || echo "  System config: ${SYSTEM_CONFIG_PATH}"
  if [ "${remove_secrets_too:-false}" != "true" ]; then
    echo "  Secrets:  the amika-hostd entries in your OS keychain"
  fi
  echo "  Amika:    run 'amika host delete <host>' to drop the host's registration"
}

detect_platform() {
  OS="$(uname -s)"
  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="darwin" ;;
    *)
      echo "Error: unsupported operating system: $OS" >&2
      exit 1
      ;;
  esac

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)   ARCH="amd64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *)
      echo "Error: unsupported architecture: $ARCH" >&2
      exit 1
      ;;
  esac
}

download_and_extract() {
  TMPDIR_INSTALL="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

  echo "Downloading ${DOWNLOAD_URL}..."
  fetch_url "$DOWNLOAD_URL" > "${TMPDIR_INSTALL}/${ARCHIVE_NAME}"
  fetch_url "$CHECKSUMS_URL" > "${TMPDIR_INSTALL}/checksums.txt"
  verify_checksum "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" "$ARCHIVE_NAME" "${TMPDIR_INSTALL}/checksums.txt"

  echo "Extracting..."
  tar -xzf "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" -C "$TMPDIR_INSTALL"

  ARCHIVE_DIR="${TMPDIR_INSTALL}/${ARCHIVE_BASE}"
  BUNDLE_PATH="${ARCHIVE_DIR}/amika-hostd.mjs"
  for expected in amika-hostd.mjs engines.sha256 node_modules/smolmachines/package.json; do
    if [ ! -f "${ARCHIVE_DIR}/${expected}" ]; then
      echo "Error: expected file not found at ${ARCHIVE_BASE}/${expected} in archive" >&2
      exit 1
    fi
  done
}

# The version in package.json $1, or nothing.
package_version() {
  grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | head -n 1 |
    sed 's/.*"\([^"]*\)"$/\1/'
}

# Remove a smolmachines engine an earlier release's setup installed, when its
# version is not the new SDK's: setup installs the matching one again.
remove_stale_engines() {
  sdk_version="$(package_version "${HOSTD_HOME}/node_modules/smolmachines/package.json")"
  for engine in "${HOSTD_HOME}"/node_modules/smolmachines-*; do
    [ -d "$engine" ] || continue
    if [ "$(package_version "${engine}/package.json")" != "$sdk_version" ]; then
      rm -rf "$engine"
      echo "Removed ${engine}, from an earlier release. Run \`amika-hostd setup\` to install the matching engine."
    fi
  done
}

install_hostd() {
  mkdir -p "$HOSTD_HOME"
  install -m 0644 "$BUNDLE_PATH" "${HOSTD_HOME}/amika-hostd.mjs"
  install -m 0644 "${ARCHIVE_DIR}/config.example.toml" \
    "${HOSTD_HOME}/config.example.toml"
  # What the daemon runs to build the macOS image Lume rigs boot, replaced
  # whole so a step a newer release dropped does not linger.
  rm -rf "${HOSTD_HOME}/macos-image"
  if [ "$OS" = "darwin" ] && [ -d "${ARCHIVE_DIR}/macos-image" ]; then
    cp -R "${ARCHIVE_DIR}/macos-image" "${HOSTD_HOME}/macos-image"
  fi
  # The smolmachines SDK and the engine checksums: setup downloads this
  # platform's engine beside the SDK when smol is on.
  install -m 0644 "${ARCHIVE_DIR}/engines.sha256" "${HOSTD_HOME}/engines.sha256"
  mkdir -p "${HOSTD_HOME}/node_modules"
  rm -rf "${HOSTD_HOME}/node_modules/smolmachines"
  cp -R "${ARCHIVE_DIR}/node_modules/smolmachines" "${HOSTD_HOME}/node_modules/smolmachines"
  remove_stale_engines

  ensure_node
  write_launcher
  install_launcher
  echo "amika-hostd ${VERSION} installed to ${INSTALL_DIR}/amika-hostd"
  print_next_steps
}

describe_plan() {
  echo "  Files:        ${HOSTD_HOME}/amika-hostd.mjs (run by the launcher above)"
  if find_system_node; then
    echo "  Node.js:      use system node v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  elif find_private_node; then
    echo "  Node.js:      use the private node v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  else
    node_dist_names
    echo "  Node.js:      no node ${NODE_MIN_MAJOR}+ found; would download"
    echo "                ${NODE_BASE_URL}/${NODE_ARCHIVE}"
    echo "                into ${HOSTD_HOME}/node"
  fi
  echo "  Next:         amika-hostd setup installs what each runtime needs"
}

# Refuse to download a Node.js that is not a patched release. It runs before
# anything is installed, and only when no usable node is already there: a
# system node is used as it is.
check_node_version() {
  find_system_node && return 0
  find_private_node && return 0
  node_version_patched "$NODE_VERSION" && return 0
  echo "Error: not installing Node.js ${NODE_VERSION} (AMIKA_HOSTD_NODE_VERSION): it predates the October 2026 security release for its major." >&2
  echo "Request at least one of $(node_floors_text) (same major), or install Node.js ${NODE_MIN_MAJOR}+ yourself." >&2
  exit 1
}

# Pick the node the launcher runs: the system node if it is new enough, else a
# private one under HOSTD_HOME, downloaded (replacing an unpatched one) if
# needed. Sets NODE_BIN.
ensure_node() {
  if find_system_node; then
    echo "Using system Node.js v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  elif find_private_node; then
    echo "Using Node.js v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  else
    report_skipped_node "$(command -v node 2>/dev/null || true)" \
      "Not using system" "Node.js ${NODE_MIN_MAJOR}+"
    report_skipped_node "${HOSTD_HOME}/node/bin/node" \
      "Replacing" "a patched release ($(node_floors_text))"
    echo "Node.js ${NODE_MIN_MAJOR}+ not found; installing Node.js ${NODE_VERSION} into ${HOSTD_HOME}/node"
    install_private_node
    find_private_node || {
      echo "Error: the downloaded Node.js at ${HOSTD_HOME}/node/bin/node does not run" >&2
      exit 1
    }
  fi
  NODE_BIN="$FOUND_NODE"
}

find_system_node() {
  candidate="$(command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] || return 1
  # Our private node is still ours when found through PATH. Compare file
  # identity so symlinks to it also go through the private version check.
  [ "$candidate" -ef "${HOSTD_HOME}/node/bin/node" ] && return 1
  node_is_supported "$candidate"
}

find_private_node() {
  node_is_patched "${HOSTD_HOME}/node/bin/node"
}

# Succeed if $1 runs and is Node.js NODE_MIN_MAJOR or newer, setting
# FOUND_NODE and FOUND_NODE_VERSION.
node_is_supported() {
  node_version="$(node_version_of "$1")"
  node_major="${node_version%%.*}"
  case "$node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$node_major" -ge "$NODE_MIN_MAJOR" ] || return 1
  FOUND_NODE="$1"
  FOUND_NODE_VERSION="$node_version"
}

# Succeed if $1 runs and is a patched Node.js release, setting FOUND_NODE and
# FOUND_NODE_VERSION.
node_is_patched() {
  node_version="$(node_version_of "$1")"
  node_version_patched "$node_version" || return 1
  FOUND_NODE="$1"
  FOUND_NODE_VERSION="$node_version"
}

# Print the version node $1 reports, or nothing when it does not run.
node_version_of() {
  [ -x "$1" ] || return 0
  "$1" -p 'process.versions.node' 2>/dev/null || true
}

# Say why the node at $1, when it runs, is not used. $2 starts the sentence
# and $3 is what amika-hostd needs instead.
report_skipped_node() {
  [ -n "$1" ] || return 0
  skipped_version="$(node_version_of "$1")"
  [ -n "$skipped_version" ] || return 0
  echo "${2} Node.js v${skipped_version} at ${1}: amika-hostd needs ${3}"
}

# Succeed if $1 is a release version (major.minor.patch) on a major in
# NODE_MIN_VERSIONS and no older than that major's entry.
node_version_patched() {
  case "$1" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  saved_ifs="$IFS"
  IFS=.
  # shellcheck disable=SC2086 # split the version on its dots
  set -- $1
  IFS="$saved_ifs"
  [ "$#" -eq 3 ] && [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] || return 1
  for floor in $NODE_MIN_VERSIONS; do
    floor_major="${floor%%.*}"
    floor_minor="${floor#*.}"; floor_minor="${floor_minor%%.*}"
    floor_patch="${floor##*.}"
    [ "$1" -eq "$floor_major" ] || continue
    [ "$2" -gt "$floor_minor" ] ||
      { [ "$2" -eq "$floor_minor" ] && [ "$3" -ge "$floor_patch" ]; }
    return
  done
  return 1
}

# NODE_MIN_VERSIONS for people: "22.23.4+, 24.22.1+ or 26.12.1+".
node_floors_text() {
  # shellcheck disable=SC2086 # one argument per version
  printf '%s+' $NODE_MIN_VERSIONS | sed 's/+\([0-9]\)/+, \1/g; s/, \([^,]*\)$/ or \1/'
}

node_dist_names() {
  case "$ARCH" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
  esac
  NODE_DIST="node-v${NODE_VERSION}-${OS}-${node_arch}"
  NODE_ARCHIVE="${NODE_DIST}.tar.gz"
  NODE_BASE_URL="${NODE_DIST_URL}/v${NODE_VERSION}"
}

# Download the official Node.js binary, verify it against SHASUMS256.txt, and
# unpack it to HOSTD_HOME/node. The system node is never touched.
install_private_node() {
  node_dist_names
  echo "Downloading ${NODE_BASE_URL}/${NODE_ARCHIVE}..."
  fetch_url "${NODE_BASE_URL}/${NODE_ARCHIVE}" > "${TMPDIR_INSTALL}/${NODE_ARCHIVE}"
  fetch_url "${NODE_BASE_URL}/SHASUMS256.txt" > "${TMPDIR_INSTALL}/SHASUMS256.txt"
  verify_checksum "${TMPDIR_INSTALL}/${NODE_ARCHIVE}" "$NODE_ARCHIVE" "${TMPDIR_INSTALL}/SHASUMS256.txt"

  staging="${HOSTD_HOME}/.node-staging"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "${TMPDIR_INSTALL}/${NODE_ARCHIVE}" -C "$staging"
  rm -rf "${HOSTD_HOME}/node"
  mv "${staging}/${NODE_DIST}" "${HOSTD_HOME}/node"
  rm -rf "$staging"
}

# The launcher pins the node chosen now, so the daemon keeps working when it
# is started from a shell (or service manager) with a different PATH.
write_launcher() {
  LAUNCHER_PATH="${TMPDIR_INSTALL}/amika-hostd-launcher"
  cat > "$LAUNCHER_PATH" <<EOF
#!/bin/sh
# amika-hostd launcher written by install-amika-hostd.sh. Re-run the installer to update.
exec $(sh_quote "$NODE_BIN") $(sh_quote "${HOSTD_HOME}/amika-hostd.mjs") "\$@"
EOF
}

sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

install_launcher() {
  ensure_install_dir
  DEST_PATH="${INSTALL_DIR}/amika-hostd"

  if [ -w "$INSTALL_DIR" ]; then
    install -m 0755 "$LAUNCHER_PATH" "$DEST_PATH"
  else
    echo "Installing to ${DEST_PATH} (requires sudo)..."
    sudo install -m 0755 "$LAUNCHER_PATH" "$DEST_PATH"
  fi
}

ensure_install_dir() {
  if [ -d "$INSTALL_DIR" ]; then
    return 0
  fi

  if [ -e "$INSTALL_DIR" ]; then
    echo "Error: install path exists and is not a directory: $INSTALL_DIR" >&2
    exit 1
  fi

  if mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    return 0
  fi

  echo "Creating install directory ${INSTALL_DIR} (requires sudo)..."
  sudo mkdir -p "$INSTALL_DIR"
}

# The paths the daemon reads, in its order (src/internal/config.ts).
config_paths() {
  CONFIG_PATH="${XDG_CONFIG_HOME:-${HOME}/.config}/amika-hostd/config.toml"
  SYSTEM_CONFIG_PATH="/etc/amika-hostd/config.toml"
}

print_next_steps() {
  echo ""
  echo "Next steps:"
  echo "  1. Set up this host. Setup asks for its hostname and your Amika API"
  echo "     key, asks which runtimes it runs (Linux VMs, macOS VMs, this"
  echo "     machine itself), and installs what each one needs:"
  echo "       amika-hostd setup"
  echo "  2. Start the daemon:"
  echo "       amika-hostd up"
  echo "  To stop it, run \`amika-hostd down\`."
  echo ""
  echo "If you're an AI agent, run \`amika-hostd setup --skill\` and follow the"
  echo "instructions it prints."
}

# Verify $1 (named $2 in the checksum list) against the sha256sum-format list
# in the file $3.
verify_checksum() {
  archive_path="$1"
  archive_name="$2"
  checksums_path="$3"

  echo "Verifying checksum..."
  checksum_line="$(grep "  ${archive_name}\$" "$checksums_path" || true)"
  if [ -z "$checksum_line" ]; then
    echo "Error: checksum for ${archive_name} not found in $(basename "$checksums_path")" >&2
    exit 1
  fi

  expected_checksum="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
  actual_checksum="$(compute_sha256 "$archive_path")"

  if [ "$expected_checksum" != "$actual_checksum" ]; then
    echo "Error: checksum mismatch for ${archive_name}" >&2
    exit 1
  fi
}

compute_sha256() {
  file_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    echo "Error: neither sha256sum nor shasum found. Please install one of them." >&2
    exit 1
  fi
}

fetch_url() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    echo "Error: neither curl nor wget found. Please install one of them." >&2
    exit 1
  fi
}

main "$@"
