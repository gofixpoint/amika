#!/bin/bash
# Adds the Docker-in-Docker runtime and marks the image for daemon startup.

set -euo pipefail

: "${DOCKER_VERSION:?DOCKER_VERSION must be set}"

case "$(uname -m)" in
  x86_64) release_arch="x86_64" ;;
  aarch64) release_arch="aarch64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends iptables uidmap

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
curl -fsSL \
  "https://download.docker.com/linux/static/stable/${release_arch}/docker-${DOCKER_VERSION}.tgz" \
  -o "$temporary_dir/docker.tgz"
tar -xzf "$temporary_dir/docker.tgz" -C "$temporary_dir"
install -m 0755 "$temporary_dir"/docker/* /usr/local/bin/

getent group docker >/dev/null || groupadd docker
usermod -aG docker amika
touch /usr/local/etc/amika/dind-enabled

rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
