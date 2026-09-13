#!/bin/bash
# Verifies the amika CLI agent skill is installed and readable by the runtime user.
# shellcheck disable=SC1091,SC2034
CHECK_ID="agent-skill"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

relative="$(manifest_value image.agent_skill)"
user="$(runtime_user)"
home="$(runtime_home)"
problems=()

owner="$(stat -c '%U:%G' "$home/$relative" 2>/dev/null || true)"
[[ -f "$home/$relative" && "$owner" == "$user:$user" ]] ||
  problems+=("$home/$relative=$owner")
# /etc/skel carries the skill as well, so a user added after the build reads
# the same file rather than an empty path.
[[ -f "/etc/skel/$relative" ]] || problems+=("/etc/skel/$relative=missing")

[[ ${#problems[@]} -eq 0 ]] && pass "agent skill installed for the runtime user and in /etc/skel" "skill readable at the declared path"
fail "agent skill installed for the runtime user and in /etc/skel" "${problems[*]}"
