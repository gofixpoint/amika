# Locally, this image is called "amika/coder-dind"

ARG DIND_IMAGE=amika/dind:latest
FROM ${DIND_IMAGE}

USER root

# Install stable coding toolchain packages.
RUN npm install -g pnpm typescript tsx

# Install agent CLI packages separately so this layer can be cache-busted
# independently (pass --build-arg AGENT_CLI_CACHE_BUST=<timestamp>) without
# reinstalling the stable toolchain above.
# Some packages' postinstall scripts write into /home/amika (e.g. creating
# /home/amika/.config) while running as root, which leaves those paths
# root-owned and breaks user-facing hooks that try to write under ~/.config.
# Reset ownership before switching users so the image is consistent regardless
# of postinstall behavior.
ARG AGENT_CLI_CACHE_BUST=
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && chown -R amika:amika /home/amika

USER amika

# Lifecycle order is pre-setup -> setup -> post-setup.
# pre-setup and post-setup run as root because they manage container-owned
# state. setup.sh runs as the amika user because it is the user-facing hook.
# Each hook is invoked through run-hook.sh so its stdout, stderr, and ERR trap
# output are written to /var/log/amika/*.log and mirrored to
# /var/log/amikad/*.log.
ENTRYPOINT ["/bin/bash", "-c", "sudo AMIKA_AGENT_CWD=\"$AMIKA_AGENT_CWD\" AMIKA_OPENCODE_WEB=\"$AMIKA_OPENCODE_WEB\" OPENCODE_SERVER_PASSWORD=\"$OPENCODE_SERVER_PASSWORD\" /usr/lib/amikad/run-hook.sh /usr/lib/amikad/pre-setup.sh && /usr/lib/amikad/run-hook.sh /usr/local/etc/amikad/setup/setup.sh && sudo /usr/lib/amikad/run-hook.sh /usr/lib/amikad/post-setup.sh && exec \"$@\"", "--"]
