#!/usr/bin/env bash
set -euo pipefail

baseline_file="test/coverage-baseline.env"
if [[ -f "$baseline_file" ]]; then
  # shellcheck disable=SC1090
  source "$baseline_file"
fi

min_internal="${AMIKA_MIN_INTERNAL_COVERAGE:-70.0}"
min_cmd="${AMIKA_MIN_CMD_COVERAGE:-35.0}"

tmp_internal="$(mktemp)"
tmp_cmd="$(mktemp)"
cleanup() {
  rm -f "$tmp_internal" "$tmp_cmd"
}
trap cleanup EXIT

internal_pkgs="$(go list ./internal/... | grep -Ev '/internal/mount($|/)')"
# shellcheck disable=SC2086  # intentional word-splitting: $internal_pkgs contains multiple package paths
go test $internal_pkgs -coverprofile="$tmp_internal" >/dev/null
go test ./cmd/amika -coverprofile="$tmp_cmd" >/dev/null

internal_cov="$(go tool cover -func="$tmp_internal" | awk '/^total:/ {gsub("%", "", $3); print $3}')"
cmd_cov="$(go tool cover -func="$tmp_cmd" | awk '/^total:/ {gsub("%", "", $3); print $3}')"

printf 'internal coverage: %s%% (min %s%%)\n' "$internal_cov" "$min_internal"
printf 'cmd/amika coverage: %s%% (min %s%%)\n' "$cmd_cov" "$min_cmd"

awk -v got="$internal_cov" -v min="$min_internal" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "internal coverage threshold failed"
  exit 1
}

awk -v got="$cmd_cov" -v min="$min_cmd" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "cmd/amika coverage threshold failed"
  exit 1
}
