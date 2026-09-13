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

for root in /etc/skel "$runtime_home"; do
  install -d -m 0755 "$root/.agents" "$root/.agents/skills"
  rm -rf "${root:?}/$skill_directory"
  install -d -m 0755 "$root/$skill_directory"
  cp -R "$1/." "$root/$skill_directory/"
  # cp preserves whatever modes the build context carried, which is a property
  # of the checkout rather than of the image. Normalize both trees instead.
  find "$root/$skill_directory" -type d -exec chmod 0755 {} +
  find "$root/$skill_directory" -type f -exec chmod 0644 {} +
done

# One recursive chown covers every directory created above, including the
# .agents and .agents/skills parents that install -d makes root-owned.
chown -R "$runtime_user:$runtime_group" "$runtime_home/.agents"
