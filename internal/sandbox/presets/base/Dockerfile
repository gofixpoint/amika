# Locally, this image is called "amika/base"

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN apt-get update && apt-get install -y \
    git \
    curl \
    sudo \
    zsh \
    build-essential \
    python3 \
    python3-pip \
    ca-certificates \
    gnupg \
    vim \
    nano \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Ghostty terminfo so SSH sessions from Ghostty render correctly.
# Source vendored from ghostty-org/ghostty src/terminfo/ghostty.zig.
COPY ghostty.terminfo /tmp/ghostty.terminfo
RUN tic -x -o /usr/share/terminfo /tmp/ghostty.terminfo \
    && rm /tmp/ghostty.terminfo

# Install Node.js 22.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (https://github.com/cli/cli/blob/trunk/docs/install_linux.md).
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Default no-op setup script; users can shadow it via --setup-script.
# This is the user-facing middle hook in the lifecycle:
# 1. /usr/lib/amikad/pre-setup.sh
# 2. /usr/local/etc/amikad/setup/setup.sh
# 3. /usr/lib/amikad/post-setup.sh
# We put setup.sh inside a setup/ directory so a whole setup volume can be
# mounted there, and we use /usr/local/etc instead of /etc because some
# sandbox providers ban mounting to /etc.
RUN mkdir -p /usr/local/etc/amikad/setup \
    && printf '#!/bin/bash\nexit 0\n' > /usr/local/etc/amikad/setup/setup.sh \
    && chmod +x /usr/local/etc/amikad/setup/setup.sh

# amikad is for the daemon; amika is for user-managed Amika files.
RUN mkdir -p \
    /var/log/amikad /var/log/amika \
    /usr/lib/amikad /usr/lib/amika \
    /run/amikad /run/amika \
    /usr/local/etc/amikad /usr/local/etc/amika \
    /var/lib/amikad /var/lib/amika \
    /tmp/amikad /tmp/amika

# Amika lifecycle hooks:
# pre-setup.sh runs first as root for Amika-managed initialization.
# setup.sh is user-supplied and runs second.
# post-setup.sh runs last as root to restore expected ownership after setup.
# run-hook.sh wraps each hook so stdout, stderr, and Bash ERR trap output land
# in /var/log/amika/<hook>.log and are mirrored to /var/log/amikad/<hook>.log.
COPY pre-setup.sh post-setup.sh opencode-setup.sh docker-setup.sh run-hook.sh bash-error-prelude.sh /usr/lib/amikad/
RUN chmod +x /usr/lib/amikad/pre-setup.sh /usr/lib/amikad/post-setup.sh /usr/lib/amikad/opencode-setup.sh /usr/lib/amikad/docker-setup.sh /usr/lib/amikad/run-hook.sh

# Create user with home directory.
RUN useradd -m -s /usr/bin/zsh amika
RUN usermod -aG sudo amika
# Let amika user run sudo without a password.
RUN echo "amika ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
RUN chown -R amika:amika \
    /var/log/amika \
    /usr/lib/amika \
    /run/amika \
    /usr/local/etc/amika \
    /var/lib/amika \
    /tmp/amika

# Everything after this point runs as the amika user.
USER amika

ENV HOME=/home/amika
RUN mkdir -p /home/amika
WORKDIR /home/amika
RUN mkdir -p /home/amika/workspace

COPY --chown=amika:amika .zshrc /home/amika/.zshrc
COPY --chown=amika:amika .bashrc /home/amika/.bashrc
COPY --chown=amika:amika .tmux.conf /home/amika/.tmux.conf
