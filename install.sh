#!/bin/sh
set -eu

INSTALL_DIR="${AMIKA_INSTALL_DIR:-/usr/local/bin}"
GITHUB_REPO="gofixpoint/amika"
INCLUDE_PRERELEASE=false
DRY_RUN=false

usage() {
  cat <<EOF
install.sh — install the amika CLI

Downloads the latest amika release binary from GitHub and installs it.

Usage:
  sh install.sh [--help] [--latest-prerelease] [--dry-run]

Flags:
  --latest-prerelease   Include prerelease versions when finding the latest release
  --dry-run             Show what would be done without downloading or installing

Environment variables:
  AMIKA_INSTALL_DIR   Override install directory (default: /usr/local/bin)

Examples:
  curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh
  AMIKA_INSTALL_DIR=~/.local/bin sh install.sh
EOF
}

main() {
  parse_args "$@"
  detect_platform
  find_latest_release

  ARCHIVE_BASE="amika_${VERSION}_${OS}_${ARCH}"
  ARCHIVE_NAME="${ARCHIVE_BASE}.tar.gz"
  DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${ARCHIVE_NAME}"

  if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "Dry run — would perform the following:"
    echo "  Platform:     ${OS}/${ARCH}"
    echo "  Version:      ${VERSION} (${TAG})"
    echo "  Download URL: ${DOWNLOAD_URL}"
    echo "  Install to:   ${INSTALL_DIR}/amika"
    exit 0
  fi

  download_and_extract
  install_binary
  echo "amika ${VERSION} installed to ${INSTALL_DIR}/amika"
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        usage
        exit 0
        ;;
      --latest-prerelease)
        INCLUDE_PRERELEASE=true
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

find_latest_release() {
  echo "Finding latest amika release..."

  RELEASES_JSON="$(fetch_url "https://api.github.com/repos/${GITHUB_REPO}/releases")"

  # Extract tag_name and prerelease fields as paired lines, then filter.
  # The GitHub API returns releases newest-first.
  # Output format: one line per release as "tag_name prerelease_bool"
  RELEASE_LINES="$(echo "$RELEASES_JSON" \
    | grep -E '"tag_name"|"prerelease"' \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/TAG \1/' \
    | sed 's/.*"prerelease": *true.*/PRE true/' \
    | sed 's/.*"prerelease": *false.*/PRE false/' \
    | paste - - \
    | sed 's/TAG \([^ ]*\).*PRE \(.*\)/\1 \2/')"

  # Filter for amika@v* tags (not amika-server@v*)
  RELEASE_LINES="$(echo "$RELEASE_LINES" | grep '^amika@v')"

  # Unless --latest-prerelease is set, exclude prereleases
  if [ "$INCLUDE_PRERELEASE" = "false" ]; then
    RELEASE_LINES="$(echo "$RELEASE_LINES" | grep ' false$')" || true
  fi

  TAG="$(echo "$RELEASE_LINES" | head -1 | awk '{print $1}')"

  if [ -z "$TAG" ]; then
    echo "Error: could not find a release matching amika@v*" >&2
    exit 1
  fi

  # Extract version from tag: amika@v1.2.3 -> 1.2.3
  VERSION="${TAG#amika@v}"
  echo "Latest release: ${TAG} (version ${VERSION})"
}

download_and_extract() {
  TMPDIR_INSTALL="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

  echo "Downloading ${DOWNLOAD_URL}..."
  fetch_url "$DOWNLOAD_URL" > "${TMPDIR_INSTALL}/${ARCHIVE_NAME}"

  echo "Extracting..."
  tar -xzf "${TMPDIR_INSTALL}/${ARCHIVE_NAME}" -C "$TMPDIR_INSTALL"

  BINARY_PATH="${TMPDIR_INSTALL}/${ARCHIVE_BASE}/amika"
  if [ ! -f "$BINARY_PATH" ]; then
    echo "Error: expected binary not found at ${ARCHIVE_BASE}/amika in archive" >&2
    exit 1
  fi

  # Remove macOS quarantine attribute if present
  if [ "$OS" = "darwin" ]; then
    xattr -d com.apple.quarantine "$BINARY_PATH" 2>/dev/null || true
  fi
}

install_binary() {
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true

  if [ -w "$INSTALL_DIR" ]; then
    mv "$BINARY_PATH" "${INSTALL_DIR}/amika"
  else
    echo "Installing to ${INSTALL_DIR}/amika (requires sudo)..."
    sudo mv "$BINARY_PATH" "${INSTALL_DIR}/amika"
  fi

  chmod +x "${INSTALL_DIR}/amika"
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
