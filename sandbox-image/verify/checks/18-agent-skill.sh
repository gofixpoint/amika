#!/bin/bash
# Verifies the amika CLI agent skill is installed and readable by the runtime user.
# shellcheck disable=SC1091,SC2034
CHECK_ID="agent-skill"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

relative="$(manifest_value image.agent_skill)"
link="$(manifest_value image.agent_skill_link)"
user="$(runtime_user)"
home="$(runtime_home)"
problems=()

owner="$(stat -c '%U:%G' "$home/$relative" 2>/dev/null || true)"
[[ -f "$home/$relative" && "$owner" == "$user:$user" ]] ||
  problems+=("$home/$relative=$owner")
# /etc/skel carries the skill as well, so a user added after the build reads
# the same file rather than an empty path.
[[ -f "/etc/skel/$relative" ]] || problems+=("/etc/skel/$relative=missing")

# Read the skill back through the Claude Code link the way that harness would,
# rather than asserting the link's target text: what matters is that the file
# arrives, and a link pointing at a path that does not resolve looks correct
# under readlink right up until an agent reads nothing. The parent remains a
# real directory so Claude-specific skills can coexist beside Amika's.
skill_file="${relative##*/}"
link_parent="${link%/*}"
for root in "$home" /etc/skel; do
  [[ -d "$root/$link_parent" && ! -L "$root/$link_parent" ]] ||
    problems+=("$root/$link_parent=not-a-directory")
  [[ -L "$root/$link" ]] || problems+=("$root/$link=not-a-symlink")
  [[ -f "$root/$link/$skill_file" ]] ||
    problems+=("$root/$link/$skill_file=unreadable")
done
# No -L, so this reports the link's own ownership rather than its target's,
# which is what a root-owned-paths sweep of the runtime home sees.
link_owner="$(stat -c '%U:%G' "$home/$link" 2>/dev/null || true)"
[[ "$link_owner" == "$user:$user" ]] || problems+=("$home/$link=$link_owner")

[[ ${#problems[@]} -eq 0 ]] && pass "agent skill installed for the runtime user, in /etc/skel, and linked for Claude Code" "skill readable at the declared path and through the link"
fail "agent skill installed for the runtime user, in /etc/skel, and linked for Claude Code" "${problems[*]}"
