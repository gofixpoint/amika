#!/bin/sh
set -eu

# amika-hostd ships as one bundled JavaScript file. It is installed into
# HOSTD_HOME (default $XDG_DATA_HOME/amika-hostd), with a launcher on
# INSTALL_DIR that runs it on a suitable node.
# It needs smolvm on the same host: `amika-hostd up` starts `smolvm serve`,
# and `amika-hostd down` stops it. It also installs the smolmachines SDK
# (smolvm's engine, embedded) the release carries, plus this platform's
# engine package from npm, checked against the release's engines.sha256.

INSTALL_DIR="${AMIKA_INSTALL_DIR:-/usr/local/bin}"
GITHUB_REPO="gofixpoint/amika"
DEFAULT_VERSION="0.1.0"
INSTALL_VERSION=""
DRY_RUN=false

HOSTD_HOME="${AMIKA_HOSTD_HOME:-${XDG_DATA_HOME:-${HOME:-}/.local/share}/amika-hostd}"
NODE_MIN_MAJOR=22
NODE_VERSION="${AMIKA_HOSTD_NODE_VERSION:-24.21.0}"
NPM_REGISTRY="${AMIKA_HOSTD_NPM_REGISTRY:-https://registry.npmjs.org}"
NPM_REGISTRY="${NPM_REGISTRY%/}"
# The smolmachines engine runs on Linux with glibc 2.34 or newer.
GLIBC_MIN="2.34"
SMOLVM_INSTALL_URL="https://smolmachines.com/install.sh"
SMOLVM_VERSION="${SMOLVM_VERSION:-}"
SKIP_SMOLVM=false

usage() {
  cat <<EOF
install-amika-hostd.sh — install the amika-hostd BYOC host daemon

Installs amika-hostd from its GitHub release, plus the Node.js ${NODE_MIN_MAJOR}+
and smolvm it needs. It uses the system node if it is new enough, and otherwise
downloads Node.js ${NODE_VERSION} into ${HOSTD_HOME}/node. If smolvm is
missing, it runs the official smolvm installer. It also installs the
smolmachines engine (smolvm, embedded) for this platform.

Supported hosts: Linux x86_64 or arm64 with glibc ${GLIBC_MIN}+, and macOS on
Apple silicon.

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
                             (default: \$XDG_DATA_HOME/amika-hostd, which is
                             ~/.local/share/amika-hostd by default)
  AMIKA_HOSTD_NODE_VERSION   Node.js version to download when the system node
                             is missing or too old (default: ${NODE_VERSION})
  SMOLVM_VERSION             Same as --smolvm-version
  AMIKA_HOSTD_NPM_REGISTRY   npm registry to fetch the engine package from
                             (default: https://registry.npmjs.org)
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
  engine_package

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

install_hostd() {
  mkdir -p "$HOSTD_HOME"
  install -m 0644 "$BUNDLE_PATH" "${HOSTD_HOME}/amika-hostd.mjs"
  install -m 0644 "${ARCHIVE_DIR}/config.example.toml" \
    "${HOSTD_HOME}/config.example.toml"
  install_engine

  ensure_node
  write_launcher
  install_launcher
  echo "amika-hostd ${VERSION} installed to ${INSTALL_DIR}/amika-hostd"

  seed_config
  ensure_smolvm
  check_kvm
  print_next_steps
}

# The npm package carrying this platform's engine (native addon, boot helper,
# hypervisor libraries and guest rootfs). Sets ENGINE_PACKAGE, or exits on a
# host the engine does not support, before anything is downloaded.
engine_package() {
  case "${OS}/${ARCH}" in
    linux/amd64)  ENGINE_PACKAGE="smolmachines-linux-x64-gnu" ;;
    linux/arm64)  ENGINE_PACKAGE="smolmachines-linux-arm64-gnu" ;;
    darwin/arm64) ENGINE_PACKAGE="smolmachines-darwin-arm64" ;;
    *)
      echo "Error: amika-hostd's machine engine (smolmachines) does not support ${OS}/${ARCH}" >&2
      exit 1
      ;;
  esac
  [ "$OS" = "linux" ] || return 0
  glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
  if [ -z "$glibc" ]; then
    echo "Error: amika-hostd's machine engine (smolmachines) needs glibc ${GLIBC_MIN} or newer; this host's C library is not glibc (musl?)" >&2
    exit 1
  fi
  if ! version_at_least "$glibc" "$GLIBC_MIN"; then
    echo "Error: amika-hostd's machine engine (smolmachines) needs glibc ${GLIBC_MIN} or newer; this host has ${glibc}" >&2
    exit 1
  fi
}

# Succeed if dotted version $1 is at least $2 (major.minor).
version_at_least() {
  have_major="${1%%.*}"; have_minor="${1#*.}"; have_minor="${have_minor%%.*}"
  want_major="${2%%.*}"; want_minor="${2#*.}"; want_minor="${want_minor%%.*}"
  [ "$have_major" -gt "$want_major" ] ||
    { [ "$have_major" -eq "$want_major" ] && [ "$have_minor" -ge "$want_minor" ]; }
}

# Install the smolmachines SDK the release carries, then download this
# platform's engine package from npm, verify it against the release's
# engines.sha256 and unpack it beside the SDK, where the SDK looks for it.
install_engine() {
  ENGINE_ARCHIVE="$(awk -v prefix="${ENGINE_PACKAGE}-" 'index($2, prefix) == 1 {print $2}' "${ARCHIVE_DIR}/engines.sha256")"
  if [ -z "$ENGINE_ARCHIVE" ]; then
    echo "Error: this release has no ${ENGINE_PACKAGE} engine" >&2
    exit 1
  fi
  engine_url="${NPM_REGISTRY}/${ENGINE_PACKAGE}/-/${ENGINE_ARCHIVE}"
  echo "Downloading ${engine_url}..."
  fetch_url "$engine_url" > "${TMPDIR_INSTALL}/${ENGINE_ARCHIVE}"
  verify_checksum "${TMPDIR_INSTALL}/${ENGINE_ARCHIVE}" "$ENGINE_ARCHIVE" "${ARCHIVE_DIR}/engines.sha256"

  staging="${HOSTD_HOME}/.node_modules-staging"
  rm -rf "$staging"
  mkdir -p "${staging}/${ENGINE_PACKAGE}"
  cp -R "${ARCHIVE_DIR}/node_modules/smolmachines" "${staging}/smolmachines"
  tar -xzf "${TMPDIR_INSTALL}/${ENGINE_ARCHIVE}" -C "${staging}/${ENGINE_PACKAGE}" --strip-components=1
  # Replace the whole directory, so an engine from an earlier release or
  # another platform never lingers.
  rm -rf "${HOSTD_HOME}/node_modules"
  mv "$staging" "${HOSTD_HOME}/node_modules"
  echo "Installed the ${ENGINE_PACKAGE} engine (${ENGINE_ARCHIVE%.tgz})"
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
  echo "  Engine:       ${ENGINE_PACKAGE}, the version the release pins, from"
  echo "                ${NPM_REGISTRY}, into ${HOSTD_HOME}/node_modules"
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

# Copy the example config to the user config path, unless the daemon already
# has a config to read. Never overwrites one.
seed_config() {
  config_paths
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
  # Fill in this machine's hostname only when it is one Amika accepts
  # (src/internal/config.ts); otherwise leave the line for the operator.
  host_name="$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  host_line='# hostname = "my-host"'
  if is_valid_hostname "$host_name"; then
    host_line="hostname = \"${host_name}\""
  else
    host_name=""
  fi
  # `amika-hostd setup` keeps the secrets in the keychain by default, or adds
  # the secret key to it with `secret_store = "file"`; keep it to the
  # daemon's user either way.
  (
    umask 077
    sed -e "s/^# hostname = \"my-host\"\$/${host_line}/" \
      "${HOSTD_HOME}/config.example.toml" > "$CONFIG_PATH"
  )
  CONFIG_HOSTNAME="$host_name"
  echo "Wrote a config to ${CONFIG_PATH}"
}

# Lowercase letters, digits, and hyphens in dot-separated labels of 1-63
# characters that start and end with a letter or digit, at most 253 in total.
is_valid_hostname() {
  [ -n "$1" ] && [ "${#1}" -le 253 ] || return 1
  printf '%s\n' "$1" | tr '.' '\n' |
    grep -Evq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' && return 1
  return 0
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
  echo ""
  echo "Next steps:"
  if [ -n "${CONFIG_HOSTNAME:-}" ]; then
    echo "  1. Store your Amika API key, and confirm this host registers as"
    echo "     ${CONFIG_HOSTNAME} (set in ${CONFIG_PATH}):"
  else
    echo "  1. Store your Amika API key, and set or confirm this host's hostname"
    echo "     in ${CONFIG_PATH}:"
  fi
  echo "       amika-hostd setup"
  echo "  2. Start the daemon, which starts smolvm with it (and runs setup first"
  echo "     if you skipped step 1):"
  echo "       amika-hostd up"
  echo "  To stop the daemon and its VMs, run \`amika-hostd down\`."
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
