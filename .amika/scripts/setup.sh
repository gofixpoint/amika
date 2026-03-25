#!/bin/bash
set -e

# Check if Go is already installed
if command -v go &>/dev/null; then
    echo "Go is already installed: $(go version)"
    exit 0
fi

echo "Go not found. Installing..."

GO_VERSION="1.26.1"
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)

# Normalize architecture name
case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz
tar -C /usr/local -xzf /tmp/go.tar.gz
rm /tmp/go.tar.gz

# Make Go available system-wide
echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile.d/golang.sh

export PATH=$PATH:/usr/local/go/bin
echo "Installed: $(go version)"
