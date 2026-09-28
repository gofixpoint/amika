#!/bin/sh
set -eu

# amika-hostd ships as one bundled JavaScript file. It is installed into
# HOSTD_HOME, with a launcher on INSTALL_DIR that runs it on a suitable node.
# It needs smolvm's HTTP API (`smolvm serve`) on the same host, which it does
# not start itself.

INSTALL_DIR="${AMIKA_INSTALL_DIR:-/usr/local/bin}"
GITHUB_REPO="gofixpoint/amika"
DEFAULT_VERSION="0.1.0"
INSTALL_VERSION=""
DRY_RUN=false

HOSTD_HOME="${AMIKA_HOSTD_HOME:-${HOME:-}/.amika-hostd}"
NODE_MIN_MAJOR=22
NODE_VERSION="${AMIKA_HOSTD_NODE_VERSION:-24.21.0}"
SMOLVM_INSTALL_URL="https://smolmachines.com/install.sh"
SMOLVM_VERSION="${SMOLVM_VERSION:-}"
SKIP_SMOLVM=false

usage() {
  cat <<EOF
install-amika-hostd.sh — install the amika-hostd BYOC host daemon

Installs amika-hostd from its GitHub release, plus the Node.js ${NODE_MIN_MAJOR}+
and smolvm it needs. It uses the system node if it is new enough, and otherwise
downloads Node.js ${NODE_VERSION} into ${HOSTD_HOME}/node. If smolvm is
missing, it runs the official smolvm installer.

Usage:
  sh install-amika-hostd.sh [--help] [--install-version VERSION] [--dry-run]
                            [--smolvm-version VERSION] [--skip-smolvm]

Flags:
  --install-version     Install a specific version (default: ${DEFAULT_VERSION})
  --dry-run             Show what would be done without downloading or installing
  --smolvm-version      Install this smolvm version if smolvm is missing
                        (default: latest)
  --skip-smolvm         Do not install smolvm

Environment variables:
  AMIKA_INSTALL_DIR          Launcher directory (default: /usr/local/bin)
  AMIKA_HOSTD_HOME           amika-hostd's files and private Node.js
                             (default: ~/.amika-hostd)
  AMIKA_HOSTD_NODE_VERSION   Node.js version to download when the system node
                             is missing or too old (default: ${NODE_VERSION})
  SMOLVM_VERSION             Same as --smolvm-version
  AMIKA_RELEASE_URL          Testing only: fetch the archive and checksums.txt
                             from this base URL (e.g. file:///path/to/dir)
                             instead of the GitHub release

Examples:
  curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
  sh install-amika-hostd.sh --install-version 0.1.0 --skip-smolvm
  AMIKA_INSTALL_DIR=~/.local/bin sh install-amika-hostd.sh
EOF
}

main() {
  parse_args "$@"
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
      --smolvm-version)
        if [ "$#" -lt 2 ]; then
          echo "Error: --smolvm-version requires a value" >&2
          exit 1
        fi
        SMOLVM_VERSION="$2"
        shift
        ;;
      --skip-smolvm)
        SKIP_SMOLVM=true
        ;;
      --dry-run)
        DRY_RUN=true
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
  verify_checksum "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" "$ARCHIVE_NAME" "$CHECKSUMS_URL"

  echo "Extracting..."
  tar -xzf "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" -C "$TMPDIR_INSTALL"

  BUNDLE_PATH="${TMPDIR_INSTALL}/${ARCHIVE_BASE}/amika-hostd.mjs"
  if [ ! -f "$BUNDLE_PATH" ]; then
    echo "Error: expected file not found at ${ARCHIVE_BASE}/amika-hostd.mjs in archive" >&2
    exit 1
  fi
}

install_hostd() {
  mkdir -p "$HOSTD_HOME"
  install -m 0644 "$BUNDLE_PATH" "${HOSTD_HOME}/amika-hostd.mjs"
  install -m 0644 "${TMPDIR_INSTALL}/${ARCHIVE_BASE}/config.example.toml" \
    "${HOSTD_HOME}/config.example.toml"

  ensure_node
  write_launcher
  install_launcher
  echo "amika-hostd ${VERSION} installed to ${INSTALL_DIR}/amika-hostd"

  seed_config
  ensure_smolvm
  check_kvm
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
  if [ "$SKIP_SMOLVM" = "true" ]; then
    echo "  smolvm:       skipped (--skip-smolvm)"
  elif find_smolvm; then
    echo "  smolvm:       found at ${SMOLVM_PATH}"
  else
    echo "  smolvm:       not found; would run ${SMOLVM_INSTALL_URL} (version: ${SMOLVM_VERSION:-latest})"
  fi
  config_paths
  if [ -e "$CONFIG_PATH" ]; then
    echo "  Config:       keep existing ${CONFIG_PATH}"
  elif [ -e "$SYSTEM_CONFIG_PATH" ]; then
    echo "  Config:       keep existing ${SYSTEM_CONFIG_PATH}"
  else
    echo "  Config:       would seed ${CONFIG_PATH} from config.example.toml"
  fi
  check_kvm
}

# Pick the node the launcher runs: the system node if it is new enough, else a
# private one under HOSTD_HOME, downloaded if needed. Sets NODE_BIN.
ensure_node() {
  if find_system_node; then
    echo "Using system Node.js v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  elif find_private_node; then
    echo "Using Node.js v${FOUND_NODE_VERSION} at ${FOUND_NODE}"
  else
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
  [ -n "$candidate" ] && node_is_supported "$candidate"
}

find_private_node() {
  node_is_supported "${HOSTD_HOME}/node/bin/node"
}

# Succeed if $1 runs and is Node.js NODE_MIN_MAJOR or newer, setting
# FOUND_NODE and FOUND_NODE_VERSION.
node_is_supported() {
  [ -x "$1" ] || return 1
  node_version="$("$1" -p 'process.versions.node' 2>/dev/null || true)"
  node_major="${node_version%%.*}"
  case "$node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$node_major" -ge "$NODE_MIN_MAJOR" ] || return 1
  FOUND_NODE="$1"
  FOUND_NODE_VERSION="$node_version"
}

node_dist_names() {
  case "$ARCH" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
  esac
  NODE_DIST="node-v${NODE_VERSION}-${OS}-${node_arch}"
  NODE_ARCHIVE="${NODE_DIST}.tar.gz"
  NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
}

# Download the official Node.js binary, verify it against SHASUMS256.txt, and
# unpack it to HOSTD_HOME/node. The system node is never touched.
install_private_node() {
  node_dist_names
  echo "Downloading ${NODE_BASE_URL}/${NODE_ARCHIVE}..."
  fetch_url "${NODE_BASE_URL}/${NODE_ARCHIVE}" > "${TMPDIR_INSTALL}/${NODE_ARCHIVE}"
  verify_checksum "${TMPDIR_INSTALL}/${NODE_ARCHIVE}" "$NODE_ARCHIVE" "${NODE_BASE_URL}/SHASUMS256.txt"

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

# Copy the example config to the user config path, unless the daemon already
# has a config to read. Never overwrites one.
seed_config() {
  config_paths
  CONFIG_SEEDED=false
  if [ -e "$CONFIG_PATH" ]; then
    echo "Keeping existing config at ${CONFIG_PATH}"
    return 0
  fi
  if [ -e "$SYSTEM_CONFIG_PATH" ]; then
    echo "Keeping existing config at ${SYSTEM_CONFIG_PATH}"
    CONFIG_PATH="$SYSTEM_CONFIG_PATH"
    return 0
  fi
  mkdir -p "$(dirname "$CONFIG_PATH")"
  # It will hold the secret key, so only the daemon's user may read it.
  (umask 077 && cp "${HOSTD_HOME}/config.example.toml" "$CONFIG_PATH")
  CONFIG_SEEDED=true
  echo "Wrote an example config to ${CONFIG_PATH}"
}

find_smolvm() {
  SMOLVM_PATH="$(command -v smolvm 2>/dev/null || true)"
  [ -n "$SMOLVM_PATH" ] && return 0
  for candidate in "${HOME}/.smolvm/smolvm" "${HOME}/.local/bin/smolvm"; do
    if [ -x "$candidate" ]; then
      SMOLVM_PATH="$candidate"
      return 0
    fi
  done
  return 1
}

# Run the official smolvm installer (into ~/.smolvm, no sudo) if smolvm is
# missing.
ensure_smolvm() {
  if [ "$SKIP_SMOLVM" = "true" ]; then
    echo "Skipping smolvm (--skip-smolvm)"
    find_smolvm || SMOLVM_PATH=""
    return 0
  fi
  if find_smolvm; then
    echo "Found smolvm at ${SMOLVM_PATH}"
    return 0
  fi

  if ! command -v bash >/dev/null 2>&1; then
    echo "Error: the smolvm installer needs bash. Install bash, or install smolvm yourself and re-run with --skip-smolvm:" >&2
    echo "  curl -sSL ${SMOLVM_INSTALL_URL} | bash" >&2
    exit 1
  fi

  echo "Installing smolvm (version: ${SMOLVM_VERSION:-latest})..."
  fetch_url "$SMOLVM_INSTALL_URL" > "${TMPDIR_INSTALL}/smolvm-install.sh"
  if [ -n "$SMOLVM_VERSION" ]; then
    set -- --version "$SMOLVM_VERSION"
  else
    set --
  fi
  if ! bash "${TMPDIR_INSTALL}/smolvm-install.sh" "$@" </dev/null; then
    echo "Error: the smolvm installer failed. amika-hostd is installed; install smolvm and re-run, or pass --skip-smolvm." >&2
    exit 1
  fi
  if ! find_smolvm; then
    echo "Error: smolvm was installed but not found at ~/.smolvm/smolvm or ~/.local/bin/smolvm" >&2
    exit 1
  fi
}

# smolvm runs VMs with KVM on Linux. A missing or inaccessible /dev/kvm is
# worth a warning, not a failed install: the host may be fixed afterwards.
check_kvm() {
  [ "$OS" = "linux" ] || return 0
  if [ ! -e /dev/kvm ]; then
    echo "" >&2
    echo "Warning: /dev/kvm not found. smolvm needs KVM to run VMs on Linux." >&2
    echo "  Enable hardware virtualization (in firmware, or nested virtualization" >&2
    echo "  on a cloud VM) and load the module: sudo modprobe kvm_intel (or kvm_amd)" >&2
  elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "" >&2
    echo "Warning: ${USER:-this user} cannot access /dev/kvm, which smolvm needs to run VMs." >&2
    echo "  Fix it with: sudo usermod -aG kvm \$USER" >&2
    echo "  then log out and back in." >&2
  fi
}

print_next_steps() {
  smolvm_cmd="${SMOLVM_PATH:-smolvm}"
  [ "$smolvm_cmd" = "$(command -v smolvm 2>/dev/null || true)" ] && smolvm_cmd="smolvm"

  echo ""
  echo "Next steps:"
  if [ "$CONFIG_SEEDED" = "true" ]; then
    echo "  1. Edit ${CONFIG_PATH}: set hostname and secret_key"
    echo "     (openssl rand -hex 32), and uncomment and fill in [sizes] and [images]."
  else
    echo "  1. Check ${CONFIG_PATH}: hostname, secret_key, [sizes] and [images]"
    echo "     (compare with ${HOSTD_HOME}/config.example.toml)."
  fi
  echo "  2. Export your Amika API key; it is read only from the environment:"
  echo "       export AMIKA_HOSTD_API_KEY=<your Amika API key>"
  echo "  3. Start smolvm's API and keep it running (amika-hostd does not start it):"
  echo "       ${smolvm_cmd} serve start --listen 127.0.0.1:8080"
  echo "  4. Start the daemon:"
  echo "       amika-hostd up"
}

# Verify $1 (named $2 in the checksum list) against the sha256sum-format list
# at $3.
verify_checksum() {
  archive_path="$1"
  archive_name="$2"
  checksums_url="$3"
  checksums_path="${TMPDIR_INSTALL}/checksums-${archive_name}.txt"

  echo "Verifying checksum..."
  fetch_url "$checksums_url" > "$checksums_path"

  checksum_line="$(grep "  ${archive_name}\$" "$checksums_path" || true)"
  if [ -z "$checksum_line" ]; then
    echo "Error: checksum for ${archive_name} not found in $(basename "$checksums_url")" >&2
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
