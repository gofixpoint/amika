#!/bin/bash
# Verifies the Daytona variant's systemd user override does not leak elsewhere.
# shellcheck disable=SC1091,SC2034
CHECK_ID="daytona-vm-user"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

provider="${AMIKA_IMAGE_PROVIDER:-shared}"
override_path="/etc/systemd/system/daytona.service.d/99-amika-user.conf"

if [[ "$provider" != "daytona" ]]; then
  [[ ! -e "$override_path" ]] && \
    pass "Daytona override exists only in the Daytona image variant" "absent for $provider"
  fail "Daytona override exists only in the Daytona image variant" "present for $provider"
fi

expected=$'[Service]\nUser=amika\nWorkingDirectory=/home/amika'
actual_content="$(cat "$override_path" 2>/dev/null || true)"
actual_metadata="$(stat -c '%U:%G:%a' "$override_path" 2>/dev/null || true)"
if [[ "$actual_content" == "$expected" && "$actual_metadata" == "root:root:644" ]]; then
  pass "Daytona override selects the runtime user with safe metadata" "$actual_metadata"
fi
fail \
  "Daytona override selects the runtime user with safe metadata" \
  "metadata=$actual_metadata content_match=$([[ "$actual_content" == "$expected" ]] && echo yes || echo no)"
