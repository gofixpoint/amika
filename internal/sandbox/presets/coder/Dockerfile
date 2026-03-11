# Locally, this image is called "amika/coder"

ARG BASE_IMAGE=amika/base:latest
FROM ${BASE_IMAGE}

USER root

# Install coding agent CLIs.
RUN npm install -g pnpm typescript tsx @anthropic-ai/claude-code @openai/codex opencode-ai

USER amika

# We run the pre-setup and post-setup as root. setup runs as the amika user.
# Pre and post-setup are not intended to be user-facing configuration. They are
# for the amika system.
ENTRYPOINT ["/bin/bash", "-c", "sudo AMIKA_AGENT_CWD=\"$AMIKA_AGENT_CWD\" /usr/lib/amikad/pre-setup.sh && /usr/local/etc/amikad/setup/setup.sh && sudo /usr/lib/amikad/post-setup.sh && exec \"$@\"", "--"]
