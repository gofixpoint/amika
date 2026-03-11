# Locally, this image is called "amika/coder"

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

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install coding agent CLIs.
RUN npm install -g pnpm typescript tsx @anthropic-ai/claude-code @openai/codex opencode-ai

# Default no-op setup script; users can shadow it via --setup-script.
# The ENTRYPOINT runs the setup script then execs into CMD, so user scripts
# don't need to include `exec "$@"` themselves.
RUN printf '#!/bin/bash\nexit 0\n' > /opt/setup.sh \
    && chmod +x /opt/setup.sh

# Create user with home directory
RUN useradd -m -s /usr/bin/zsh amika
RUN usermod -aG sudo amika
# Let amika user run sudo without a password
RUN echo "amika ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Everything after this point runs as the amika user
USER amika

ENV HOME=/home/amika
RUN mkdir -p /home/amika
WORKDIR /home/amika

ENTRYPOINT ["/bin/bash", "-c", "/opt/setup.sh && exec \"$@\"", "--"]
