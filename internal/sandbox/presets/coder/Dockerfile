FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/amika

RUN apt-get update && apt-get install -y \
    git \
    curl \
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
RUN npm install -g typescript tsx @anthropic-ai/claude-code @openai/codex opencode-ai

RUN mkdir -p /home/amika
WORKDIR /home/amika

# Default no-op setup script; users can shadow it via --setup-script.
# The ENTRYPOINT runs the setup script then execs into CMD, so user scripts
# don't need to include `exec "$@"` themselves.
RUN printf '#!/bin/bash\nexit 0\n' > /opt/setup.sh \
    && chmod +x /opt/setup.sh
ENTRYPOINT ["/bin/bash", "-c", "/opt/setup.sh && exec \"$@\"", "--"]
