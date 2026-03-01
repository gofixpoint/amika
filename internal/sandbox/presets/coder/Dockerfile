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
