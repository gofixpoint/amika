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
    ncurses-term \
    && rm -rf /var/lib/apt/lists/*

# Install Ghostty terminfo so SSH sessions from Ghostty render correctly.
# (Alacritty, kitty, foot, etc. come from the ncurses-term package above;
# Ghostty isn't in ncurses-term on Ubuntu 24.04, so we vendor it.)
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

# Install the amika and amikalog CLIs from their GitHub releases, landing in
# /usr/local/bin (on PATH).
#   amika:    sandbox / agent management CLI.
#   amikalog: captures Claude Code / Codex hook activity as append-only events.
# Pin both the installer and the versions to a release rather than the moving
# `main` branch, so an image built for any commit is reproducible and never
# picks up whatever amika/amikalog defaults happen to be on `main` at build time.
# Passing the versions explicitly also means bumping them changes this RUN and so
# busts Docker's layer cache (a plain install.sh edit would not). `%40` is the
# URL-encoded `@` in the release tag `amika@v<version>`. Fetch the script to a
# file rather than `curl | sh`: Docker's /bin/sh is dash (no pipefail), so a
# piped curl failure would exit 0 and silently skip the install.
ARG AMIKA_VERSION=0.11.2
ARG AMIKALOG_VERSION=0.2.0
RUN curl -fsSL "https://raw.githubusercontent.com/gofixpoint/amika/amika%40v${AMIKA_VERSION}/install.sh" -o /tmp/amika-install.sh \
    && sh /tmp/amika-install.sh --install-version "${AMIKA_VERSION}" \
    && sh /tmp/amika-install.sh --component amikalog --install-version "${AMIKALOG_VERSION}" \
    && rm /tmp/amika-install.sh

# Default no-op user-facing hooks; callers can shadow them via
# --setup-script / --start-script or by uploading their own.
# Lifecycle order:
# 1. /usr/lib/amikad/pre-setup.sh
# 2. /usr/local/etc/amikad/setup/setup.sh
# 3. /usr/local/etc/amikad/setup/start.sh
# 4. /usr/lib/amikad/post-setup.sh
# We put the user-facing hooks inside a setup/ directory so a whole setup
# volume can be mounted there, and we use /usr/local/etc instead of /etc
# because some sandbox providers ban mounting to /etc.
RUN mkdir -p /usr/local/etc/amikad/setup \
    && printf '#!/bin/bash\nexit 0\n' > /usr/local/etc/amikad/setup/setup.sh \
    && printf '#!/bin/bash\nexit 0\n' > /usr/local/etc/amikad/setup/start.sh \
    && chmod +x /usr/local/etc/amikad/setup/setup.sh /usr/local/etc/amikad/setup/start.sh

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

# Daytona builds linux-vm sandboxes by converting this OCI image into a VM
# rootfs, and that conversion strips the setuid bit from every setuid binary --
# /usr/bin/sudo drops from 4755 to 0755. The amika lifecycle relies on the
# unprivileged `amika` user escalating through passwordless sudo, so a VM whose
# sudo isn't setuid can't initialize. Inside the VM nothing we can reach runs as
# root (both command exec and the fs toolbox run as `amika`), so it can't be
# repaired after boot -- instead we record the setuid binaries now, while the
# bits are intact, and a systemd oneshot re-applies them early on every VM boot
# (systemd is PID 1 in Daytona VMs, and sysinit runs before the Daytona agent).
# Inert on container sandboxes: systemd is not their init, and their setuid bits
# survive the plain image pull.
RUN find / -xdev -perm -4000 -type f > /usr/lib/amikad/setuid-manifest.txt 2>/dev/null || true
COPY restore-setuid.sh /usr/lib/amikad/restore-setuid.sh
COPY amika-restore-setuid.service /etc/systemd/system/amika-restore-setuid.service
RUN chmod +x /usr/lib/amikad/restore-setuid.sh \
    && mkdir -p /etc/systemd/system/sysinit.target.wants \
    && ln -sf /etc/systemd/system/amika-restore-setuid.service \
       /etc/systemd/system/sysinit.target.wants/amika-restore-setuid.service

# Everything after this point runs as the amika user.
USER amika

ENV HOME=/home/amika
RUN mkdir -p /home/amika
WORKDIR /home/amika
RUN mkdir -p /home/amika/workspace

COPY --chown=amika:amika .zshrc /home/amika/.zshrc
COPY --chown=amika:amika .bashrc /home/amika/.bashrc
COPY --chown=amika:amika .tmux.conf /home/amika/.tmux.conf
