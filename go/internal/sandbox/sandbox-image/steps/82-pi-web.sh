#!/bin/bash
# Installs the pinned Pi Web UI (https://github.com/agegr/pi-web).
#
# Pi's own CLI has no web server, so this is what `pi-setup.sh` serves: a
# browser UI over the same `~/.pi/agent` state the CLI uses, the way
# `opencode web` fronts OpenCode.
#
# Installed separately from the agent CLIs because it pulls its own copy of
# `@earendil-works/pi-coding-agent` as a library dependency. npm links only the
# top-level package's bin, so `/usr/local/bin/pi` stays the version pinned in
# 80-agent-clis.sh; the UI uses its bundled copy internally.

set -euo pipefail

: "${PI_WEB_VERSION:?PI_WEB_VERSION must be set}"

npm install -g --engine-strict --ignore-scripts "@agegr/pi-web@${PI_WEB_VERSION}"

chown -R amika:amika /home/amika
rm -rf /root/.npm /root/.cache
