# Locally, this image is called "amika/base"

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

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
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Default no-op setup script; users can shadow it via --setup-script.
# We put setup.sh inside a setup/ directory so we can mount an entire setup
# volume there. We use /usr/local/etc instead of /etc because some sandbox
# providers ban mounting to /etc.
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

# Amika hook scripts that run before/after the user setup script.
# pre-setup.sh: clones repo, optionally starts opencode web when enabled.
# post-setup.sh: chowns /home/amika to the amika user.
RUN printf '#!/bin/bash\nsudo chown -R amika:amika /home/amika\n' > /usr/lib/amikad/post-setup.sh \
    && chmod +x /usr/lib/amikad/post-setup.sh
COPY pre-setup.sh opencode-setup.sh /usr/lib/amikad/
RUN chmod +x /usr/lib/amikad/pre-setup.sh /usr/lib/amikad/opencode-setup.sh

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
