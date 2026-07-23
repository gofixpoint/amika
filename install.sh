#!/bin/sh
set -eu

INSTALL_DIR="${AMIKA_INSTALL_DIR:-/usr/local/bin}"
GITHUB_REPO="gofixpoint/amika"
DEFAULT_VERSION="0.12.1"
DEFAULT_AMIKALOG_VERSION="0.2.0"
COMPONENT="amika"
INSTALL_VERSION=""
DRY_RUN=false

usage() {
  cat <<EOF
install.sh — install an amika release binary

Downloads a specific release binary from GitHub and installs it. Installs the
amika CLI by default, or the separately-versioned amikalog CLI with --component.

Usage:
  sh install.sh [--help] [--component NAME] [--install-version VERSION] [--dry-run]

Flags:
  --component           Component to install: amika (default) or amikalog
  --install-version     Install a specific version
                        (amika default: ${DEFAULT_VERSION}; amikalog default: ${DEFAULT_AMIKALOG_VERSION})
  --dry-run             Show what would be done without downloading or installing

Environment variables:
  AMIKA_INSTALL_DIR   Override install directory (default: /usr/local/bin)

Examples:
  curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh
  sh install.sh --install-version 0.1.0-rc.1
  sh install.sh --component amikalog --install-version 0.2.0
  AMIKA_INSTALL_DIR=~/.local/bin sh install.sh
EOF
}

main() {
  parse_args "$@"
  detect_platform
  set_install_version

  ARCHIVE_BASE="${COMPONENT}_${VERSION}_${OS}_${ARCH}"
  ARCHIVE_NAME="${ARCHIVE_BASE}.tar.gz"
  DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${ARCHIVE_NAME}"
  CHECKSUMS_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/checksums.txt"

  if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — would perform the following:"
    echo "  Component:    ${COMPONENT}"
    echo "  Platform:     ${OS}/${ARCH}"
    echo "  Version:      ${VERSION} (${TAG})"
    echo "  Download URL: ${DOWNLOAD_URL}"
    echo "  Checksums:    ${CHECKSUMS_URL}"
    echo "  Install to:   ${INSTALL_DIR}/${COMPONENT}"
    exit 0
  fi

  download_and_extract
  install_binary
  echo "${COMPONENT} ${VERSION} installed to ${INSTALL_DIR}/${COMPONENT}"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --help|-h)
        usage
        exit 0
        ;;
      --component)
        if [ "$#" -lt 2 ]; then
          echo "Error: --component requires a value" >&2
          exit 1
        fi
        COMPONENT="$2"
        shift
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

set_install_version() {
  case "$COMPONENT" in
    amika) ;;
    amikalog) ;;
    *)
      echo "Error: unsupported component: $COMPONENT (want amika or amikalog)" >&2
      exit 1
      ;;
  esac

  if [ -z "$INSTALL_VERSION" ]; then
    case "$COMPONENT" in
      amika)    INSTALL_VERSION="$DEFAULT_VERSION" ;;
      amikalog) INSTALL_VERSION="$DEFAULT_AMIKALOG_VERSION" ;;
    esac
  fi

  VERSION="${INSTALL_VERSION#v}"
  TAG="${COMPONENT}@v${VERSION}"
  echo "Installing ${COMPONENT} release: ${TAG}"
}

download_and_extract() {
  TMPDIR_INSTALL="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

  echo "Downloading ${DOWNLOAD_URL}..."
  fetch_url "$DOWNLOAD_URL" > "${TMPDIR_INSTALL}/${ARCHIVE_NAME}"
  verify_checksum "${TMPDIR_INSTALL}/${ARCHIVE_NAME}"

  echo "Extracting..."
  tar -xzf "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" -C "$TMPDIR_INSTALL"

  BINARY_PATH="${TMPDIR_INSTALL}/${ARCHIVE_BASE}/${COMPONENT}"
  if [ ! -f "$BINARY_PATH" ]; then
    echo "Error: expected binary not found at ${ARCHIVE_BASE}/${COMPONENT} in archive" >&2
    exit 1
  fi

  # Remove macOS quarantine attribute if present
  if [ "$OS" = "darwin" ]; then
    xattr -d com.apple.quarantine "$BINARY_PATH" 2>/dev/null || true
  fi
}

install_binary() {
  ensure_install_dir
  DEST_PATH="${INSTALL_DIR}/${COMPONENT}"

  if [ -w "$INSTALL_DIR" ]; then
    install -m 0755 "$BINARY_PATH" "$DEST_PATH"
  else
    echo "Installing to ${DEST_PATH} (requires sudo)..."
    sudo install -m 0755 "$BINARY_PATH" "$DEST_PATH"
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

verify_checksum() {
  archive_path="$1"
  checksums_path="${TMPDIR_INSTALL}/checksums.txt"

  echo "Verifying checksum..."
  fetch_url "$CHECKSUMS_URL" > "$checksums_path"

  checksum_line="$(grep "  ${ARCHIVE_NAME}\$" "$checksums_path" || true)"
  if [ -z "$checksum_line" ]; then
    echo "Error: checksum for ${ARCHIVE_NAME} not found in checksums.txt" >&2
    exit 1
  fi

  expected_checksum="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
  actual_checksum="$(compute_sha256 "$archive_path")"

  if [ "$expected_checksum" != "$actual_checksum" ]; then
    echo "Error: checksum mismatch for ${ARCHIVE_NAME}" >&2
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
