#!/bin/bash
# shellcheck disable=SC2034

set -u

: "${CHECK_ID:?check must set CHECK_ID before sourcing check.sh}"
: "${CHECK_CONTEXTS:?check must set CHECK_CONTEXTS before sourcing check.sh}"

VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
METADATA_DIR="${AMIKA_IMAGE_METADATA_DIR:-/usr/lib/amika-image}"
MANIFEST_PATH="${AMIKA_IMAGE_MANIFEST:-$METADATA_DIR/manifest.toml}"
VERSIONS_PATH="${AMIKA_IMAGE_VERSIONS:-$METADATA_DIR/versions.env}"
PRESET="${AMIKA_PRESET:-coder}"

if [[ "${1:-}" == "--metadata" ]]; then
  python3 - "$CHECK_ID" "$CHECK_CONTEXTS" <<'PY'
import json
import sys

print(json.dumps({"id": sys.argv[1], "contexts": sys.argv[2].split(",")}, separators=(",", ":")))
PY
  exit 0
fi

emit_result() {
  local status="$1"
  local expected="$2"
  local actual="$3"
  python3 - "$CHECK_ID" "$status" "$expected" "$actual" <<'PY'
import json
import sys

print(json.dumps({
    "id": sys.argv[1],
    "status": sys.argv[2],
    "expected": sys.argv[3],
    "actual": sys.argv[4],
}, separators=(",", ":")))
PY
}

pass() {
  emit_result "passed" "$1" "$2"
  exit 0
}

fail() {
  emit_result "failed" "$1" "$2"
  exit 0
}

skip() {
  emit_result "skipped" "$1" "$2"
  exit 0
}

manifest_lines() {
  python3 "$VERIFY_DIR/lib/manifest.py" "$MANIFEST_PATH" "$1" lines
}

manifest_value() {
  python3 "$VERIFY_DIR/lib/manifest.py" "$MANIFEST_PATH" "$1" value
}

runtime_user() {
  manifest_value image.runtime_user
}

runtime_home() {
  manifest_value image.runtime_home
}

standard_path() {
  manifest_value image.standard_path
}

run_as_runtime_user() {
  local user home path
  user="$(runtime_user)"
  home="$(runtime_home)"
  path="$(standard_path)"
  sudo -u "$user" env HOME="$home" PATH="$path" "$@"
}
