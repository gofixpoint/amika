#!/usr/bin/env bash
set -euo pipefail

baseline_file="go/test/coverage-baseline.env"
if [[ -f "$baseline_file" ]]; then
  # shellcheck disable=SC1090
  source "$baseline_file"
fi

min_internal="${AMIKA_MIN_INTERNAL_COVERAGE:-70.0}"
min_cmd="${AMIKA_MIN_CMD_COVERAGE:-35.0}"
min_labs="${AMIKA_MIN_LABS_COVERAGE:-70.0}"
min_labs_cmd="${AMIKA_MIN_LABS_CMD_COVERAGE:-70.0}"

tmp_internal="$(mktemp)"
tmp_cmd="$(mktemp)"
tmp_labs="$(mktemp)"
tmp_labs_cmd="$(mktemp)"
cleanup() {
  rm -f "$tmp_internal" "$tmp_cmd" "$tmp_labs" "$tmp_labs_cmd"
}
trap cleanup EXIT

internal_pkgs="$(go -C go list ./internal/... | grep -Ev '/internal/mount($|/)')"
labs_pkgs="$(go -C go list ./labs/... | grep -Ev '/labs/cmd($|/)')"
# shellcheck disable=SC2086  # intentional word-splitting: $internal_pkgs contains multiple package paths
go -C go test $internal_pkgs -coverprofile="$tmp_internal" >/dev/null
go -C go test ./cmd/amika -coverprofile="$tmp_cmd" >/dev/null
# shellcheck disable=SC2086  # intentional word-splitting: $labs_pkgs contains multiple package paths
go -C go test $labs_pkgs -coverprofile="$tmp_labs" >/dev/null
go -C go test ./labs/cmd/... -coverprofile="$tmp_labs_cmd" >/dev/null

internal_cov="$(go -C go tool cover -func="$tmp_internal" | awk '/^total:/ {gsub("%", "", $3); print $3}')"
cmd_cov="$(go -C go tool cover -func="$tmp_cmd" | awk '/^total:/ {gsub("%", "", $3); print $3}')"
labs_cov="$(go -C go tool cover -func="$tmp_labs" | awk '/^total:/ {gsub("%", "", $3); print $3}')"
labs_cmd_cov="$(go -C go tool cover -func="$tmp_labs_cmd" | awk '/^total:/ {gsub("%", "", $3); print $3}')"

printf 'internal coverage: %s%% (min %s%%)\n' "$internal_cov" "$min_internal"
printf 'cmd/amika coverage: %s%% (min %s%%)\n' "$cmd_cov" "$min_cmd"
printf 'labs coverage: %s%% (min %s%%)\n' "$labs_cov" "$min_labs"
printf 'labs/cmd coverage: %s%% (min %s%%)\n' "$labs_cmd_cov" "$min_labs_cmd"

awk -v got="$internal_cov" -v min="$min_internal" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "internal coverage threshold failed"
  exit 1
}

awk -v got="$cmd_cov" -v min="$min_cmd" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "cmd/amika coverage threshold failed"
  exit 1
}

awk -v got="$labs_cov" -v min="$min_labs" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "labs coverage threshold failed"
  exit 1
}

awk -v got="$labs_cmd_cov" -v min="$min_labs_cmd" 'BEGIN { exit (got+0 >= min+0 ? 0 : 1) }' || {
  echo "labs/cmd coverage threshold failed"
  exit 1
}
