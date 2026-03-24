# Locally, this image is called "amika/coder-dind"

ARG DIND_IMAGE=amika/dind:latest
FROM ${DIND_IMAGE}

USER root

# Install coding agent CLIs.
RUN npm install -g pnpm typescript tsx @anthropic-ai/claude-code @openai/codex opencode-ai

USER amika

# Lifecycle order is pre-setup -> setup -> post-setup.
# pre-setup and post-setup run as root because they manage container-owned
# state. setup.sh runs as the amika user because it is the user-facing hook.
# Each hook is invoked through run-hook.sh so its stdout, stderr, and ERR trap
# output are written to /var/log/amika/*.log and mirrored to
# /var/log/amikad/*.log.
ENTRYPOINT ["/bin/bash", "-c", "sudo AMIKA_AGENT_CWD=\"$AMIKA_AGENT_CWD\" AMIKA_OPENCODE_WEB=\"$AMIKA_OPENCODE_WEB\" OPENCODE_SERVER_PASSWORD=\"$OPENCODE_SERVER_PASSWORD\" /usr/lib/amikad/run-hook.sh /usr/lib/amikad/pre-setup.sh && /usr/lib/amikad/run-hook.sh /usr/local/etc/amikad/setup/setup.sh && sudo /usr/lib/amikad/run-hook.sh /usr/lib/amikad/post-setup.sh && exec \"$@\"", "--"]
