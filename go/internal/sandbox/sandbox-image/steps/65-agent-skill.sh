#!/bin/bash
# Installs the amika CLI agent skill for current and future runtime users.
#
# An agent working inside a sandbox has no reliable way to fetch the skill for
# itself: the repository it was given may not carry a copy, and reaching for
# the canonical one costs a network round trip it has no reason to know to
# make. The image carries it so the file is simply there.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <skill-assets-directory>" >&2
  exit 64
fi

runtime_user="${AMIKA_RUNTIME_USER:-amika}"
runtime_group="${AMIKA_RUNTIME_GROUP:-$runtime_user}"
runtime_home="${AMIKA_RUNTIME_HOME:-/home/$runtime_user}"
skill_directory=".agents/skills/amika-cli"
claude_skills_directory=".claude/skills"
claude_skill_link="$claude_skills_directory/amika-cli"

for root in /etc/skel "$runtime_home"; do
  install -d -m 0755 "$root/.agents" "$root/.agents/skills"
  rm -rf "${root:?}/$skill_directory"
  install -d -m 0755 "$root/$skill_directory"
  cp -R "$1/." "$root/$skill_directory/"
  # cp preserves whatever modes the build context carried, which is a property
  # of the checkout rather than of the image. Normalize both trees instead.
  find "$root/$skill_directory" -type d -exec chmod 0755 {} +
  find "$root/$skill_directory" -type f -exec chmod 0644 {} +

  # opencode and pi both load ~/.agents/skills on their own. Claude Code does
  # not: it loads user skills from ~/.claude/skills and reads ~/.agents/skills
  # only as an import source, so without this link the skill above is invisible
  # to it. Link this skill rather than the whole skills directory: a base image
  # or later setup can then carry Claude-only skills beside Amika's. A link
  # rather than a second copy lets the two discovery paths share one source.
  #
  # Replace the whole-directory link shipped by older images before making the
  # parent directory. Leave a real existing directory and all its other skills
  # intact. The relative target resolves inside each copied user's own home.
  install -d -m 0755 "$root/.claude"
  [[ ! -L "$root/$claude_skills_directory" ]] ||
    rm "$root/$claude_skills_directory"
  install -d -m 0755 "$root/$claude_skills_directory"
  rm -rf "${root:?}/$claude_skill_link"
  ln -s ../../.agents/skills/amika-cli "$root/$claude_skill_link"
done

# One recursive chown covers every directory created above, including the
# .agents and .agents/skills parents that install -d makes root-owned.
chown -R "$runtime_user:$runtime_group" "$runtime_home/.agents"
# The link is chowned with -h so the ownership lands on the link itself. Its
# target is inside .agents, which the recursive chown above already covered,
# and `find -user` reads the link rather than the target when the image is
# checked for root-owned paths in the runtime home.
chown "$runtime_user:$runtime_group" \
  "$runtime_home/.claude" "$runtime_home/$claude_skills_directory"
chown -h "$runtime_user:$runtime_group" "$runtime_home/$claude_skill_link"
