#!/bin/bash

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  bash \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  iproute2 \
  nano \
  ncurses-term \
  openssh-server \
  procps \
  python3 \
  python3-pip \
  sudo \
  tmux \
  vim \
  xz-utils \
  zsh

rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
