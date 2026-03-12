# Locally, this image is called "amika/claude"

ARG BASE_IMAGE=amika/base:latest
FROM ${BASE_IMAGE}

USER root

# Install pnpm, TypeScript, and Claude Code CLI.
RUN npm install -g pnpm typescript tsx @anthropic-ai/claude-code

USER amika

# Lifecycle order is pre-setup -> setup -> post-setup.
# pre-setup and post-setup run as root because they manage container-owned
# state. setup.sh runs as the amika user because it is the user-facing hook.
# Each hook is invoked through run-hook.sh so its stdout, stderr, and ERR trap
# output are written to /var/log/amikad/pre-setup.log, setup.log, and
# post-setup.log.
ENTRYPOINT ["/bin/bash", "-c", "sudo AMIKA_AGENT_CWD=\"$AMIKA_AGENT_CWD\" AMIKA_OPENCODE_WEB=\"$AMIKA_OPENCODE_WEB\" OPENCODE_SERVER_PASSWORD=\"$OPENCODE_SERVER_PASSWORD\" /usr/lib/amikad/run-hook.sh /usr/lib/amikad/pre-setup.sh && /usr/lib/amikad/run-hook.sh /usr/local/etc/amikad/setup/setup.sh && sudo /usr/lib/amikad/run-hook.sh /usr/lib/amikad/post-setup.sh && exec \"$@\"", "--"]
