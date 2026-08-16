#!/bin/bash
# Installs pinned system packages and Git for the base Ubuntu image layer.

set -euo pipefail

: "${GIT_VERSION:?GIT_VERSION must be set}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  autoconf \
  bash \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  gettext \
  iproute2 \
  libcurl4-openssl-dev \
  libexpat1-dev \
  libssl-dev \
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
  zlib1g-dev \
  zsh

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
curl -fsSL \
  "https://github.com/git/git/archive/refs/tags/v${GIT_VERSION}.tar.gz" \
  -o "$temporary_dir/git.tar.gz"
tar -xzf "$temporary_dir/git.tar.gz" -C "$temporary_dir"
pushd "$temporary_dir/git-${GIT_VERSION}" >/dev/null
make configure
./configure --prefix=/usr
make -j"$(nproc)" NO_TCLTK=YesPlease
make install NO_TCLTK=YesPlease
popd >/dev/null

rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
